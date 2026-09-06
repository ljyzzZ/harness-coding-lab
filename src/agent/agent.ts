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

    async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
        // TODO 1：先 append userMessage，同一个对象只能追加一次。
        this._context.messages.push(userMessage);
        // TODO 2：for step = 1 ... maxSteps，调用 model.stream。
        for (let step = 1; step <= this.maxSteps; step++) {
            // TODO 3：遍历累计 snapshot，但只保留最后一个完整 AssistantMessage。
            let assistantMessage: AssistantMessage | undefined;
            for await (const snapshot of this.model.stream(this._context)) {
                assistantMessage = snapshot;
            }
            if (!assistantMessage) {
                throw new Error("Model stream did not yield an assistant message");
            }
            // TODO 4：append/yield assistant message，保持 transcript 与 event 顺序一致。
            this._context.messages.push(assistantMessage);
            yield {
                type: "message",
                message: assistantMessage,
            };
            // TODO 5：提取 tool_use；没有 Tool call 时立即 return。
            const toolUses = this._extractToolUses(assistantMessage);
            if (toolUses.length === 0) {
                return
            }
            // TODO 6：本阶段按数组顺序逐个执行，并 append/yield ToolMessage。
            // TODO 7：Tool failure 也序列化成 observation，不从 loop 直接 throw。
            for (const toolUse of toolUses) {
                const toolMessage = await this._invokeTool(toolUse);
                this._context.messages.push(toolMessage);
                yield {
                    type: "message",
                    message: toolMessage
                }
            }
        }
        // TODO 8：循环耗尽后抛出带 maxSteps 的 MaximumStepsError。
        throw new MaximumStepsError({ maxSteps: this.maxSteps });
    }

    private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
        // TODO 9：使用 filter + type predicate；禁止 `as ToolUseContent[]`。
        return message.content.filter(
            (content): content is ToolUseContent => content.type === "tool_use",
        );
    }

    private async _invokeTool(toolUse: ToolUseContent): Promise<ToolMessage> {
        // TODO 10：通过 ToolRegistry 执行并用 serializeToolResult 转为字符串；
        // tool_use_id 必须原样复制 toolUse.id。
        const toolResult = await this._toolRegistry.invoke({ name: toolUse.name, input: toolUse.input });

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