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

export class Agent {
    private readonly _context: AgentContext;
    private readonly _toolRegistry: ToolRegistry;

    readonly model: Model;
    readonly maxSteps: number;

    private _streaming = false;
    private _abortController: AbortController | null = null;

    constructor(options: {
        model: Model;
        prompt: string;
        messages?: NonSystemMessage[];
        tools?: Tool[];
        maxSteps?: number;
    }) {
        // 标准实现示例：复制外部数组，默认最多运行 20 个 step。
        this.model = options.model;
        this.maxSteps = options.maxSteps ?? 20;
        this._context = {
            prompt: options.prompt,
            messages: [...(options.messages ?? [])],
            tools: [...(options.tools ?? [])],
        };
        this._toolRegistry = new ToolRegistry({ tools: options.tools ?? [] })
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
        this._streaming = true;
        try {
            // TODO 1：放入 5.0 的主循环，包括 userMessage 追加和 MaximumStepsError。
            // userMessage 只追加一次；重入检查必须发生在追加之前。
            this._context.messages.push(userMessage);
            // for step = 1 ... maxSteps，调用 model.stream。
            for (let step = 1; step <= this.maxSteps; step++) {
                // TODO 2：取本次 signal，每轮开始检查中止，并传给 _think(signal)、_act(toolUses, signal)。
                // 在 _think 返回后、_act 完成后也检查中止，避免取消被当成正常结束或达到步数上限。
                const signal = this._abortController.signal;
                signal.throwIfAborted();
                const assistantMessage = yield* this._think(signal);

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

                signal.throwIfAborted();
            }
            // 循环耗尽后抛出带 maxSteps 的 MaximumStepsError。
            throw new MaximumStepsError({ maxSteps: this.maxSteps });
        } finally {
            this._streaming = false;
            this._abortController = null;
        }
    }

    private async *_think(signal?: AbortSignal): AsyncGenerator<AgentEvent, AssistantMessage> {
        // 遍历累计 snapshot，但只保留最后一个完整 AssistantMessage。
        let latest: AssistantMessage | undefined;
        for await (const snapshot of this.model.stream({ ...this._context, signal })) {
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
            signal?.throwIfAborted();
            remaining.delete(resolved.index);
            // TODO 3：把 resolved.message 先 append 到 transcript，再 yield message event。
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
        // TODO 10：通过 ToolRegistry 执行并用 serializeToolResult 转为字符串；
        // tool_use_id 必须原样复制 toolUse.id。
        const toolResult = await this._toolRegistry.invoke({ name: toolUse.name, input: toolUse.input, signal: signal });

        return {
            role: "tool",
            content: [{
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: serializeToolResult(toolResult.ok ? toolResult.value : toolResult),
            }]
        }
    }
}