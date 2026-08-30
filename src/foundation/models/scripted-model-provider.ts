import type { AssistantMessage, TextContent } from "@/foundation/messages";

import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

export class ScriptedModelProvider implements ModelProvider {
    private readonly _responses: AssistantMessage[];
    private _cursor = 0;

    constructor({ responses }: { responses: AssistantMessage[] }) {
        this._responses = responses;
    }

    async invoke({ signal }: ModelProviderInvokeParams): Promise<AssistantMessage> {
        // 标准实现示例：中止优先于任何状态推进。
        signal?.throwIfAborted();

        const response = this._responses[this._cursor];
        if (!response) {
            throw new Error("ScriptedModelProvider has no response left");
        }

        this._cursor += 1;
        return structuredClone(response);
    }

    async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
        // TODO 1：先检查 params.signal，再读取当前 response，且只推进一次 cursor。
        const signal = params.signal;
        signal?.throwIfAborted();

        const response = this._responses[this._cursor];
        if (!response) {
            throw new Error("ScriptedModelProvider has no response left");
        }
        this._cursor += 1;
        // TODO 2：本阶段 fixture 只含一个 text block；按 Unicode code point 逐步累积文本。
        const block = response.content[0];
        if (!block || block.type !== "text") {
            throw new Error("Scripted response must contain one text block");
        }
        const characters = Array.from(block.text);
        // TODO 3：每次 yield 都返回完整 AssistantMessage，例如 h、he、hel。
        // TODO 4：最后一次 yield 必须与完整 response 深度相等。
        // 提示：使用 Array.from(text) 避免把 emoji 的 surrogate pair 拆开。
        let accumulatedText = "";

        for (const char of characters) {
            accumulatedText += char;

            const partialResponse = structuredClone(response);

            // 提示：把 partialResponse.content[0]
            // 替换成 type 为 "text"、text 为 accumulatedText 的文本块
            const replaceContent: TextContent = { type: "text", text: accumulatedText };
            partialResponse.content[0] = replaceContent;

            yield partialResponse;

        }
    }
}