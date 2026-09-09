import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming } from "openai/resources";

import type { AssistantMessage, TokenUsage } from "@/foundation/messages";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

import {
    convertToOpenAIMessages,
    convertToOpenAITools,
    parseOpenAIAssistantMessage,
} from "./utils";
import { tr } from "zod/locales";

function toTokenUsage(usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}): TokenUsage | undefined {
    if (!usage) return undefined;
    return {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
    };
}

export class OpenAIModelProvider implements ModelProvider {
    private readonly _client: OpenAI;

    constructor(options: { baseURL?: string; apiKey?: string; client?: OpenAI } = {}) {
        // 标准实现示例：允许测试注入 fake client；production 才创建真实 SDK client。
        this._client = options.client ?? new OpenAI({
            baseURL: options.baseURL,
            apiKey: options.apiKey,
        });
    }

    async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
        // TODO 1：调用 this._baseChatCompletionParams(params)，得到 SDK 请求体 request。
        const request = this._baseChatCompletionParams({
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            options: params.options
        });
        // TODO 2：await this._client.chat.completions.create(request, { signal: params.signal })，
        // 将完整 SDK 响应保存为 response。
        const response = await this._client.chat.completions.create(request, { signal: params.signal });

        // TODO 3：将 response.choices[0]!.message 和 toTokenUsage(response.usage)
        // 传给 parseOpenAIAssistantMessage，并返回转换结果。
        if (!response.choices[0]) {
            throw new Error("llm's response is null")
        }
        return parseOpenAIAssistantMessage(response.choices[0].message, toTokenUsage(response.usage));
    }

    async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
        // 7A 先保留接口；7B 再接入 StreamAccumulator 并实现累计 snapshot。
        const request = this._streamChatCompletionParams({
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            options: params.options
        });

        const responseStream = await this._client.chat.completions.create(request, {signal: params.signal});
        for await (const trunk of responseStream) {
            
        }
        throw new Error("TODO: implement OpenAIModelProvider.stream in 7B");
    }

    private _baseChatCompletionParams({
        model,
        messages,
        tools,
        options,
    }: ModelProviderInvokeParams): ChatCompletionCreateParamsNonStreaming {
        return {
            model,
            messages: convertToOpenAIMessages(messages),
            tools: tools ? convertToOpenAITools(tools) : undefined,
            temperature: 0,
            ...options,
        };
    }

    private _streamChatCompletionParams({
        model,
        messages,
        tools,
        options,
    }: ModelProviderInvokeParams): ChatCompletionCreateParamsStreaming {
        return {
            model,
            messages: convertToOpenAIMessages(messages),
            tools: tools ? convertToOpenAITools(tools) : undefined,
            temperature: 0,
            stream: true,
            ...options,
        };
    }
}