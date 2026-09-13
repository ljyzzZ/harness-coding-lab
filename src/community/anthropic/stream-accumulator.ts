import type { AssistantMessage, TokenUsage } from "@/foundation/messages";

import type { AnthropicThinkingContent } from "./utils";

export type ProviderChunk =
    | { type: "text_delta"; index: number; text: string }
    | { type: "thinking_start"; index: number; thinking: string; signature: string }
    | { type: "thinking_delta"; index: number; thinking: string }
    | { type: "signature_delta"; index: number; signature: string }
    | { type: "tool_start"; index: number; id: string; name: string }
    | { type: "input_json_delta"; index: number; partialJson: string }
    | { type: "message_start"; inputTokens: number }
    | { type: "message_end"; outputTokens: number };

interface TextBlockState {
    type: "text";
    text: string;
}

interface ThinkingBlockState {
    type: "thinking";
    thinking: string;
    signature: string;
}

interface ToolBlockState {
    type: "tool_use";
    id: string;
    name: string;
    partialJson: string;
}

type BlockState = TextBlockState | ThinkingBlockState | ToolBlockState;

export class StreamAccumulator {
    // Map 的 key 是响应内的 block index；不要用 tool id 或到达顺序代替。
    private readonly _blocks = new Map<number, BlockState>();
    private _promptTokens: number | undefined;
    private _completionTokens: number | undefined;

    push(chunk: ProviderChunk): void {
        // usage 事件没有 index；先用 in 收窄，再读取对应 block 的累计状态。
        const blockState = "index" in chunk ? this._blocks.get(chunk.index) : undefined;

        switch (chunk.type) {
            case "text_delta": {
                // 示例：首次 delta 创建状态，后续 delta 追加文本。
                // 即使首个 chunk.text 为空，也会建立 text block。
                if (blockState === undefined) {
                    this._blocks.set(chunk.index, { type: "text", text: chunk.text });
                    break;
                }
                if (blockState.type !== "text") {
                    throw new Error(`INVALID_BLOCK_TYPE: expected text at index ${chunk.index}`);
                }
                blockState.text += chunk.text;
                break;
            }
            case "thinking_start":
                // TODO 1.1：为 chunk.index 建立 ThinkingBlockState。
                // 保存 chunk.thinking 和 chunk.signature，包括空字符串。
                // start 应只出现一次；若 blockState 已存在，抛错，避免覆盖累计内容。
                if (blockState === undefined) {
                    this._blocks.set(chunk.index, {
                        type: "thinking",
                        thinking: chunk.thinking,
                        signature: chunk.signature,
                    });
                } else {
                    throw new Error(`think_start should init once at index ${chunk.index}`);
                }
                break;
            case "thinking_delta":
                // TODO 1.2：检查 blockState 存在且 type === "thinking"，再追加 thinking。
                // 不要从 delta 临时创建 thinking block，否则会遗漏 start 中的文本和签名。
                // Map.get 可能返回 undefined；通过检查后，TS 才允许访问 thinking 字段。
                if (blockState === undefined) {
                    throw new Error(`thinking_delta has not init at index ${chunk.index}`);
                }
                if (blockState.type !== "thinking") {
                    throw new Error(
                        `INVALID_BLOCK_TYPE: expected thinking at index ${chunk.index}`,
                    );
                }
                blockState.thinking += chunk.thinking;
                break;
            case "signature_delta":
                // TODO 1.3：检查 blockState 是 thinking，再更新它的 signature。
                // 本节 ProviderChunk 的 signature 是完整签名：使用赋值，不使用 +=。
                // 不要追加到 thinking 文本，也不要更新其他 index 的签名。
                if (blockState === undefined) {
                    throw new Error(`signature_delta has not init at index ${chunk.index}`);
                }
                if (blockState.type !== "thinking") {
                    throw new Error(
                        `INVALID_BLOCK_TYPE: expected thinking at index ${chunk.index}`,
                    );
                }
                blockState.signature = chunk.signature;
                break;
            case "tool_start":
                // TODO 1.4：为 chunk.index 建立 ToolBlockState。
                // 保存 id、name，partialJson 初始化为 ""；重复 start 应报错。
                // 参数先保存为字符串，JSON 片段可能还不完整，不要在这里 JSON.parse。
                if (blockState === undefined) {
                    this._blocks.set(chunk.index, {
                        type: "tool_use",
                        id: chunk.id,
                        name: chunk.name,
                        partialJson: "",
                    });
                } else {
                    throw new Error(`tool_start should init once at index ${chunk.index}`);
                }
                break;
            case "input_json_delta":
                // TODO 1.5：检查 blockState 是 tool_use，再把 chunk.partialJson 追加进去。
                // 每个 index 有自己的 partialJson；多个 Tool 交错到达时不能混用缓冲区。
                if (blockState === undefined) {
                    throw new Error(`input_json_delta has not init at index ${chunk.index}`);
                }
                if (blockState.type !== "tool_use") {
                    throw new Error(
                        `INVALID_BLOCK_TYPE: expected tool_use at index ${chunk.index}`,
                    );
                }
                blockState.partialJson += chunk.partialJson;
                break;
            case "message_start":
                // 示例：记录 provider 明确报告的输入 token 数，0 也是有效值。
                this._promptTokens = chunk.inputTokens;
                break;
            case "message_end":
                this._completionTokens = chunk.outputTokens;
                break;
        }
    }

    snapshot(): AssistantMessage {
        // 示例：Map 按插入顺序遍历，输出前必须按 index 做数值排序。
        const orderedBlocks = [...this._blocks.entries()].sort(
            ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
        );
        const content = orderedBlocks.map(([, blockState]): AssistantMessage["content"][number] => {
            switch (blockState.type) {
                case "text":
                    return { type: "text", text: blockState.text };
                case "thinking": {
                    // 示例：累计状态使用 signature，内部消息使用 _anthropicSignature。
                    // 流式快照允许签名暂时为空；不要调用会拒绝空签名的发送端转换函数。
                    const thinkingContent: AnthropicThinkingContent = {
                        type: "thinking",
                        thinking: blockState.thinking,
                        _anthropicSignature: blockState.signature,
                    };
                    return thinkingContent;
                }
                case "tool_use":
                    return {
                        type: "tool_use",
                        id: blockState.id,
                        name: blockState.name,
                        input: this._parseToolInput(blockState.partialJson),
                    };
            }
        });

        // 每次都返回新对象；不能把 Map 中可变的 blockState 直接放进 content。
        return { role: "assistant", content, usage: this._snapshotUsage() };
    }

    private _parseToolInput(partialJson: string): Record<string, unknown> {
        // TODO 2：生成当前快照使用的 Tool input。
        // 1. partialJson 为空时返回一个新的 {}。
        // 2. 用 try/catch 包裹 JSON.parse，并把结果先声明为 unknown。
        // 3. JSON 尚未完整、解析失败时，暂时返回新的 {}，不要让流式快照中断。
        // 4. 解析成功后检查非 null 的 object 且不是数组，再作为 Record 返回；
        //    对于 null、数组、字符串等不符合 Tool input 契约的值，也暂时返回 {}。
        // 每次 snapshot 都重新解析，确保嵌套对象也独立，调用方不能反向修改后续快照。
        // 这里只提供中间展示；流结束时的严格 JSON 校验由后续 Provider 阶段负责。
        if (partialJson.length === 0) {
            return {};
        }
        try {
            const json: unknown = JSON.parse(partialJson);
            if (json === null || Array.isArray(json) || typeof json !== "object") {
                return {};
            }
            return json as Record<string, unknown>;
        } catch {
            return {};
        }
    }

    private _snapshotUsage(): TokenUsage | undefined {
        // 示例：两个计数都已报告时才生成完整 usage，缺失时不伪造 0。
        if (this._promptTokens === undefined || this._completionTokens === undefined) {
            return undefined;
        }
        return {
            promptTokens: this._promptTokens,
            completionTokens: this._completionTokens,
            totalTokens: this._promptTokens + this._completionTokens,
        };
    }
}
