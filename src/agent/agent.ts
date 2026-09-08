import type {
    AssistantMessage,
    NonSystemMessage,
    ToolMessage,
    ToolUseContent,
    UserMessage,
} from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ToolRegistry, type Tool } from "@/foundation/tools";

import type { AgentContext } from "./agent-context";
import type { AgentEvent } from "./agent-event";
import { MaximumStepsError } from "./errors";
import { serializeToolResult } from "./serialize-tool-result";
import type { AgentMiddleware } from "./agent-middleware";
import type { ModelContext } from "@/foundation/models";

type BeforeToolUseDecision =
    | { skip: false }
    | { skip: true; result: unknown };

export class Agent {
    private readonly _context: AgentContext;
    private readonly _toolRegistry: ToolRegistry;

    readonly model: Model;
    readonly maxSteps: number;

    private _streaming = false;
    private _abortController: AbortController | null = null;

    private readonly _middlewares: AgentMiddleware[];

    constructor(options: {
        model: Model;
        prompt: string;
        messages?: NonSystemMessage[];
        tools?: Tool[];
        maxSteps?: number;
        middlewares?: AgentMiddleware[];
    }) {
        // 标准实现示例：复制外部数组，默认最多运行 20 个 step。
        this.model = options.model;
        this.maxSteps = options.maxSteps ?? 20;
        this._context = {
            prompt: options.prompt,
            messages: [...(options.messages ?? [])],
            tools: [...(options.tools ?? [])],
        };
        this._toolRegistry = new ToolRegistry({ tools: options.tools ?? [] });
        this._middlewares = [...(options.middlewares ?? [])];
    }

    get messages(): NonSystemMessage[] {
        return [...this._context.messages];
    }

    get streaming() {
        return this._streaming;
    }

    abort() {
        this._abortController?.abort();
    }

    async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
        if (this._streaming) throw new Error("Agent is already streaming");

        this._abortController = new AbortController();
        const signal = this._abortController.signal;
        this._streaming = true;
        try {
            // userMessage 只追加一次；重入检查必须发生在追加之前。
            this._context.messages.push(userMessage);
            signal.throwIfAborted();
            await this._beforeAgentRun();
            signal.throwIfAborted();
            for (let step = 1; step <= this.maxSteps; step++) {
                signal.throwIfAborted();
                await this._beforeAgentStep(step);
                signal.throwIfAborted();
                const assistantMessage = yield* this._think(signal);
                signal.throwIfAborted();
                await this._afterModel(assistantMessage);
                signal.throwIfAborted();

                // append/yield assistant message，保持 transcript 与 event 顺序一致。
                this._context.messages.push(assistantMessage);
                yield {
                    type: "message",
                    message: assistantMessage,
                };
                signal.throwIfAborted();
                // 提取 tool_use；没有 Tool call 时立即 return。
                const toolUses = this._extractToolUses(assistantMessage);
                if (toolUses.length === 0) return;

                yield* this._act(toolUses, signal);
                await this._afterAgentStep(step);
                signal.throwIfAborted();
            }
            // 循环耗尽后抛出带 maxSteps 的 MaximumStepsError。
            throw new MaximumStepsError({ maxSteps: this.maxSteps });
        } finally {
            try {
                await this._afterAgentRun();
            } finally {
                this._streaming = false;
                this._abortController = null;
            }
        }
    }

    private async *_think(signal?: AbortSignal): AsyncGenerator<AgentEvent, AssistantMessage> {
        // 遍历累计 snapshot，但只保留最后一个完整 AssistantMessage。
        let latest: AssistantMessage | undefined;
        const modelContext = { ...this._context, signal };
        signal?.throwIfAborted();
        await this._beforeModel(modelContext);
        signal?.throwIfAborted();

        for await (const snapshot of this.model.stream(modelContext)) {
            signal?.throwIfAborted();
            latest = snapshot;

            const latestToolUse = this._extractToolUses(snapshot).at(-1);

            if (!latestToolUse) {
                yield {
                    type: "progress",
                    subtype: "thinking",
                }
            } else {
                yield {
                    type: "progress",
                    subtype: "tool",
                    name: latestToolUse.name,
                    input: latestToolUse.input
                }
            }
            signal?.throwIfAborted();
        }
        if (!latest) throw new Error("Model stream did not yield an assistant message");
        return latest;
    }

    private async* _act(toolUses: ToolUseContent[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
        const pending = toolUses.map(async (toolUse, index) => {
            const message = await this._invokeTool(toolUse, signal);
            return { index, message };
        });

        const remaining = new Set(pending.map((_, index) => index));

        while (remaining.size > 0) {
            signal?.throwIfAborted();
            const candidates = [...remaining].map((index) => pending[index]!);
            const resolved = await Promise.race(candidates);
            remaining.delete(resolved.index);
            // 把 resolved.message 先 append 到 transcript，再 yield message event。
            // 不得按 resolved.index 重新排序，也不要重复序列化或再次执行 Tool。
            this._context.messages.push(resolved.message);
            yield {
                type: "message",
                message: resolved.message
            }
        }
    }

    private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
        // TODO 9：使用 filter + type predicate；禁止 `as ToolUseContent[]`。
        return message.content.filter(
            (content): content is ToolUseContent => content.type === "tool_use",
        );
    }

    private async _invokeTool(toolUse: ToolUseContent, signal?: AbortSignal): Promise<ToolMessage> {
        signal?.throwIfAborted();
        const decision = await this._beforeToolUse(toolUse);
        signal?.throwIfAborted();

        let toolResult: unknown;
        if (decision.skip) {
            toolResult = decision.result;
        } else {
            const execution = await this._toolRegistry.invoke({ name: toolUse.name, input: toolUse.input, signal: signal });

            if (!execution.ok && execution.code === "ABORTED") {
                signal?.throwIfAborted();
            }
            // 成功时取实际返回值；失败时保留完整错误信息。
            toolResult = execution.ok ? execution.value : execution;
        }

        await this._afterToolUse(toolUse, toolResult);

        return {
            role: "tool",
            content: [{
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: serializeToolResult(toolResult),
            }]
        }
    }

    private async _beforeAgentRun(): Promise<void> {
        for (const middleware of this._middlewares) {
            const result = await middleware.beforeAgentRun?.({
                agentContext: this._context,
            });
            // 修改保存在 Agent 上，后续 step 会继续使用这些字段。
            if (result) Object.assign(this._context, result);
        }
    }

    private async _afterAgentRun(): Promise<void> {
        for (const middleware of this._middlewares) {
            const result = await middleware.afterAgentRun?.({
                agentContext: this._context,
            });
            if (result) Object.assign(this._context, result);
        }
    }

    private async _beforeAgentStep(step: number): Promise<void> {
        for (const middleware of this._middlewares) {
            const result = await middleware.beforeAgentStep?.({
                agentContext: this._context,
                step: step,
            });
            if (result) Object.assign(this._context, result);
        }
    }

    private async _afterAgentStep(step: number): Promise<void> {
        for (const middleware of this._middlewares) {
            const result = await middleware.afterAgentStep?.({
                agentContext: this._context,
                step: step,
            });
            if (result) Object.assign(this._context, result);
        }
    }

    private async _beforeModel(modelContext: ModelContext): Promise<void> {
        for (const middleware of this._middlewares) {
            // host 在这里真正调用 hook；
            // ?. 让未实现 beforeModel 的 Middleware 自动跳过。
            // await 保证当前 hook 完成并合并结果后，才轮到下一个 Middleware。
            const result = await middleware.beforeModel?.({
                modelContext,
                agentContext: this._context,
            });
            // 只修改本次模型请求的视图。Object.assign 是浅合并：同名字段由后者覆盖。
            // 例如返回 { messages: [...] } 会替换整个 messages 字段，而不是自动追加。
            if (result) Object.assign(modelContext, result);
        }
    }

    private async _afterModel(message: AssistantMessage): Promise<void> {
        for (const middleware of this._middlewares) {
            const result = await middleware.afterModel?.({
                agentContext: this._context,
                message,
            });
            // 原地更新本次回复；下一个 Middleware 和后续 Tool 提取都读取更新后的对象。
            if (result) Object.assign(message, result);
        }
    }

    private async _beforeToolUse(toolUse: ToolUseContent): Promise<BeforeToolUseDecision> {
        for (const middleware of this._middlewares) {
            const result = await middleware.beforeToolUse?.({
                agentContext: this._context,
                toolUse: toolUse,
            });
            if (!result) continue;

            if ("__skip" in result) {
                // 此时类型是 { __skip: true; result: unknown }
                return {
                    skip: true,
                    result: result.result,
                };
            }

            // 此时类型是 Partial<AgentContext>
            Object.assign(this._context, result);
        }
        return { skip: false };
    }

    private async _afterToolUse(toolUse: ToolUseContent, toolResult: unknown): Promise<void> {
        for (const middleware of this._middlewares) {
            const result = await middleware.afterToolUse?.({
                agentContext: this._context,
                toolUse: toolUse,
                toolResult: toolResult,
            })
            if (result) Object.assign(this._context, result);
        }
    }

}
