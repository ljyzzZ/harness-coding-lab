import Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage } from "@/foundation/messages";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

import { StreamAccumulator, type ProviderChunk } from "./stream-accumulator";
import {
    convertToAnthropicMessages,
    convertToAnthropicTools,
    extractSystemPrompt,
    parseAnthropicAssistantMessage,
    type AnthropicThinkingContent,
} from "./utils";

interface StreamToolInput {
    id: string;
    initialInput: unknown;
    partialJson?: string;
}

/** 将 Anthropic 请求与流式响应转换为内部消息。 */
export class AnthropicModelProvider implements ModelProvider {
    private readonly _client: Anthropic;

    constructor(options: { baseURL?: string; apiKey?: string; client?: Anthropic } = {}) {
        this._client = options.client ?? new Anthropic({
            baseURL: options.baseURL,
            apiKey: options.apiKey,
        });
    }

    /** 发送非流式请求，返回完整的 assistant 消息。 */
    async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
        params.signal?.throwIfAborted();
        const request = {
            ...this._baseMessageParams(params),
            stream: false,
        } satisfies Anthropic.MessageCreateParamsNonStreaming;
        const response = await this._client.messages.create(request, { signal: params.signal });
        params.signal?.throwIfAborted();
        return parseAnthropicAssistantMessage(response);
    }

    /** 逐步输出独立的累计快照，并在结束前校验工具参数与 thinking 签名。 */
    async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
        params.signal?.throwIfAborted();
        const request = {
            ...this._baseMessageParams(params),
            stream: true,
        } satisfies Anthropic.MessageCreateParamsStreaming;
        const responseStream = await this._client.messages.create(request, { signal: params.signal });
        const accumulator = new StreamAccumulator();
        // accumulator 的 {} 是展示占位；保留原始 JSON 才能做最终校验。
        const toolInputs = new Map<number, StreamToolInput>();
        const openBlocks = new Set<number>();
        const startedBlocks = new Set<number>();
        let messageStarted = false;

        for await (const event of responseStream) {
            params.signal?.throwIfAborted();
            switch (event.type) {
                case "message_start":
                    if (messageStarted) {
                        throw new Error("DUPLICATE_MESSAGE_START: expected one response per stream");
                    }
                    messageStarted = true;
                    break;
                case "content_block_start": {
                    if (startedBlocks.has(event.index)) {
                        throw new Error(`DUPLICATE_BLOCK_START: index ${event.index}`);
                    }
                    startedBlocks.add(event.index);
                    openBlocks.add(event.index);
                    const anthropicContent = event.content_block;
                    if (anthropicContent.type === "tool_use") {
                        toolInputs.set(event.index, {
                            id: anthropicContent.id,
                            initialInput: anthropicContent.input,
                        });
                    }
                    break;
                }
                case "content_block_delta": {
                    if (!openBlocks.has(event.index)) {
                        throw new Error(`MISSING_BLOCK_START: index ${event.index}`);
                    }
                    if (event.delta.type === "input_json_delta") {
                        const toolInput = toolInputs.get(event.index);
                        if (!toolInput) {
                            throw new Error(`INVALID_BLOCK_TYPE: expected tool_use at index ${event.index}`);
                        }
                        toolInput.partialJson = (toolInput.partialJson ?? "") + event.delta.partial_json;
                    }
                    break;
                }
                case "content_block_stop": {
                    if (!openBlocks.delete(event.index)) {
                        throw new Error(`MISSING_BLOCK_START: index ${event.index}`);
                    }
                    const toolInput = toolInputs.get(event.index);
                    if (toolInput) this._parseFinalToolInput(toolInput);
                    break;
                }
                case "message_stop": {
                    if (!messageStarted || openBlocks.size > 0) {
                        throw new Error("INCOMPLETE_STREAM: message stopped before its blocks completed");
                    }
                    for (const [index, toolInput] of toolInputs) {
                        const input = this._parseFinalToolInput(toolInput);
                        // 没有 JSON delta 时保留 start 的 input，允许无参数工具使用 {}。
                        if (toolInput.partialJson === undefined) {
                            accumulator.push({
                                type: "input_json_delta",
                                index,
                                partialJson: JSON.stringify(input),
                            });
                        }
                    }
                    const final = accumulator.snapshot();
                    for (const assistantContent of final.content) {
                        if (assistantContent.type !== "thinking") continue;
                        const signature = (assistantContent as AnthropicThinkingContent)._anthropicSignature;
                        if (typeof signature !== "string" || signature.length === 0) {
                            throw new Error("MISSING_THINKING_SIGNATURE: stream ended with unsigned thinking");
                        }
                    }
                    yield final;
                    return;
                }
            }

            const chunks = this._toProviderChunks(event);
            for (const chunk of chunks) accumulator.push(chunk);
            if (chunks.length > 0) yield accumulator.snapshot();
        }

        // SDK 可能在取消时直接结束迭代；不能把取消或断流当成成功完成。
        params.signal?.throwIfAborted();
        throw new Error("INCOMPLETE_STREAM: missing message_stop");
    }

    private _baseMessageParams({
        model,
        messages,
        tools,
        options,
    }: ModelProviderInvokeParams): Anthropic.MessageCreateParamsNonStreaming {
        return {
            model,
            max_tokens: 8192,
            system: extractSystemPrompt(messages),
            messages: convertToAnthropicMessages(messages),
            tools: tools ? convertToAnthropicTools(tools) : undefined,
            ...options,
        };
    }

    private _toProviderChunks(event: Anthropic.RawMessageStreamEvent): ProviderChunk[] {
        switch (event.type) {
            case "message_start":
                return [
                    { type: "message_start", inputTokens: event.message.usage.input_tokens },
                    { type: "message_end", outputTokens: event.message.usage.output_tokens },
                ];
            case "message_delta": {
                const chunks: ProviderChunk[] = [];
                // SDK usage 为累计值，覆盖已有计数；null 表示本次没有更新。
                if (typeof event.usage.input_tokens === "number") {
                    chunks.push({ type: "message_start", inputTokens: event.usage.input_tokens });
                }
                if (typeof event.usage.output_tokens === "number") {
                    chunks.push({ type: "message_end", outputTokens: event.usage.output_tokens });
                }
                return chunks;
            }
            case "content_block_start": {
                const anthropicContent = event.content_block;
                switch (anthropicContent.type) {
                    case "text":
                        return [{ type: "text_delta", index: event.index, text: anthropicContent.text }];
                    case "thinking":
                        return [{
                            type: "thinking_start",
                            index: event.index,
                            thinking: anthropicContent.thinking,
                            signature: anthropicContent.signature,
                        }];
                    case "tool_use":
                        return [{
                            type: "tool_start",
                            index: event.index,
                            id: anthropicContent.id,
                            name: anthropicContent.name,
                        }];
                    default:
                        throw new Error(`UNSUPPORTED_CONTENT_BLOCK: ${anthropicContent.type}`);
                }
            }
            case "content_block_delta":
                switch (event.delta.type) {
                    case "text_delta":
                        return [{ type: "text_delta", index: event.index, text: event.delta.text }];
                    case "thinking_delta":
                        return [{ type: "thinking_delta", index: event.index, thinking: event.delta.thinking }];
                    case "signature_delta":
                        return [{ type: "signature_delta", index: event.index, signature: event.delta.signature }];
                    case "input_json_delta":
                        return [{ type: "input_json_delta", index: event.index, partialJson: event.delta.partial_json }];
                    case "citations_delta":
                        // 内部 TextContent 不包含引用元数据，与非流式解析保持一致。
                        return [];
                }
                break;
        }
        return [];
    }

    private _parseFinalToolInput(toolInput: StreamToolInput): Record<string, unknown> {
        let input: unknown = toolInput.initialInput;
        if (toolInput.partialJson !== undefined) {
            try {
                input = JSON.parse(toolInput.partialJson);
            } catch (cause) {
                throw new Error(`INVALID_TOOL_INPUT: invalid JSON for call ${toolInput.id}`, { cause });
            }
        }
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
            throw new Error(`INVALID_TOOL_INPUT: expected object for call ${toolInput.id}`);
        }
        return input as Record<string, unknown>;
    }
}
