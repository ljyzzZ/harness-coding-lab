import type { AssistantMessage, AssistantMessageContent, TokenUsage } from "@/foundation/messages";

export interface ProviderChunk {
    textDelta?: string;
    thinkingDelta?: string;
    toolCall?: {
        index: number;
        id?: string;
        name?: string;
        argumentsDelta?: string;
    };
    usage?: TokenUsage;
}

export class StreamAccumulator {
    private _text = "";
    private _thinking = "";
    private readonly _toolCalls = new Map<number, {
        id: string;
        name: string;
        argumentsText: string;
    }>();
    private _usage?: TokenUsage;

    push(chunk: ProviderChunk): void {
        if (chunk.textDelta) {
            // 标准实现示例：delta 只写 accumulator，不写 Agent transcript。
            this._text += chunk.textDelta;
        }
        // TODO 1：thinking delta 追加到 _thinking。
        if (chunk.thinkingDelta) {
            this._thinking += chunk.thinkingDelta;
        }
        // TODO 2：按 Tool call index 合并 id、name 和 argumentsText，不能按到达顺序串线。
        if (chunk.toolCall) {
            const item = this._toolCalls.getOrInsert(chunk.toolCall.index, {
                id: "", name: "", argumentsText: ""
            });
            if (chunk.toolCall.id) {
                item.id = chunk.toolCall.id;
            }
            if (chunk.toolCall.name) {
                item.name = chunk.toolCall.name;
            }
            if (chunk.toolCall.argumentsDelta) {
                item.argumentsText += chunk.toolCall.argumentsDelta;
            }
            this._toolCalls.set(chunk.toolCall.index, item);
        }
        // TODO 3：provider 给出 usage 时覆盖 _usage。
        if (chunk.usage) {
            this._usage = chunk.usage;
        }
    }

    snapshot(): AssistantMessage {
        // TODO 4：按稳定顺序构造完整 content 数组；argumentsText 不完整时暂用 {}。
        // TODO 5：返回新对象和新数组，调用方修改 snapshot 不能污染 accumulator。
        const content: AssistantMessageContent = [];

        if (this._thinking) {
            content.push({
                type: "thinking",
                thinking: this._thinking,
            });
        }

        if (this._text) {
            content.push({
                type: "text",
                text: this._text,
            });
        }

        const sortedToolCalls = [...this._toolCalls.entries()]
            .sort(([indexA], [indexB]) => indexA - indexB);

        for (const [, toolCall] of sortedToolCalls) {
            let input: Record<string, unknown> = {};

            try {
                input = JSON.parse(toolCall.argumentsText);
            } catch {
                // 参数尚未拼接完整时，暂不放入快照。
                // 与原项目一致：收到 usage 后，解析失败则以 {} 兜底。
                if (this._usage === undefined) {
                    continue;
                }
            }

            content.push({
                type: "tool_use",
                id: toolCall.id,
                name: toolCall.name,
                input,
            });
        }

        return {
            role: "assistant",
            content,
            usage: structuredClone(this._usage),
        };
    }
}