import Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, Message, ThinkingContent } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface AnthropicThinkingContent extends ThinkingContent {
    // 流式中间快照可能尚未收到签名。
    _anthropicSignature?: string;
}

function parseAnthropicThinking(block: Anthropic.ThinkingBlock): AnthropicThinkingContent {
    return {
        type: "thinking",
        thinking: block.thinking,
        _anthropicSignature: block.signature,
    };
}

function convertToAnthropicThinking(item: ThinkingContent): Anthropic.ThinkingBlockParam {
    const signature = (item as AnthropicThinkingContent)._anthropicSignature;
    if (typeof signature !== "string" || signature.length === 0) {
        throw new Error("MISSING_THINKING_SIGNATURE: cannot replay an unsigned thinking block");
    }
    return { type: "thinking", thinking: item.thinking, signature };
}

export function extractSystemPrompt(messages: Message[]): string | undefined {
    // TODO 1：只收集 system text，并用两个换行连接；没有 system 时返回 undefined。
    // 参数规则：不得修改 messages，也不得把非 system 内容混入 prompt。
    const systemMessages = messages.filter((message) => message.role === "system");
    if (systemMessages.length === 0) {
        return undefined;
    }
    return systemMessages
        .flatMap((message) => message.content.map((textContent) => textContent.text))
        .join("\n\n");
}

export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
    // TODO 2：排除 system message，并把 Tool result 转成 user-role content。
    // 参数规则：保持原始消息及 content block 顺序，不修改 canonical messages。
    // assistant thinking 分支调用 convertToAnthropicThinking，保留空 thinking 文本。
    const nonSystemMessages = messages.filter((message) => message.role !== "system");

    const messageParams: Anthropic.MessageParam[] = [];

    for (const message of nonSystemMessages) {
        switch (message.role) {
            case "assistant":
                messageParams.push({
                    role: "assistant",
                    content: message.content.map(
                        (assistantContent): Anthropic.ContentBlockParam => {
                            switch (assistantContent.type) {
                                case "text":
                                    // TODO 2.1：返回 text block，字段为 type 和 text。
                                    // 空字符串也是有效内容，不要用 if (assistantContent.text) 过滤。
                                    return {
                                        type: "text",
                                        text: assistantContent.text,
                                    };
                                case "thinking":
                                    // TODO 2.2：返回 convertToAnthropicThinking(assistantContent) 的结果。
                                    // 复用签名校验；即使 thinking 为空也要保留该 block。
                                    return convertToAnthropicThinking(assistantContent);
                                case "tool_use":
                                    // TODO 2.3：返回 type、id、name、input 四个字段。
                                    // input 保持对象，不需要像 OpenAI arguments 那样 JSON.stringify。
                                    // 不要重新生成 id，后面的 tool_result 要靠它关联调用。
                                    return {
                                        type: "tool_use",
                                        id: assistantContent.id,
                                        name: assistantContent.name,
                                        input: assistantContent.input,
                                    };
                            }
                        },
                    ),
                });
                break;
            case "user":
                messageParams.push({
                    role: "user",
                    content: message.content.map((userContent) => {
                        if (userContent.type === "text") {
                            return {
                                type: "text",
                                text: userContent.text,
                            };
                        }

                        return {
                            type: "image",
                            source: {
                                type: "url",
                                url: userContent.image_url.url,
                            },
                        };
                    }),
                });
                break;
            case "tool":
                messageParams.push({
                    // Anthropic 用 user 消息承载工具结果，没有独立的 tool role。
                    role: "user",
                    content: message.content.map((toolContent): Anthropic.ToolResultBlockParam => {
                        // TODO 2.4：返回 type="tool_result"、tool_use_id 和 content。
                        // 一条 ToolMessage 内的多个结果放进同一个 content 数组，顺序不变。
                        // toolContent.content 已经是字符串，直接保留，不要再次 JSON.stringify。
                        return {
                            type: "tool_result",
                            tool_use_id: toolContent.tool_use_id,
                            content: toolContent.content,
                        };
                    }),
                });
                break;
        }
    }
    return messageParams;
}

export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
    return tools.map((tool): Anthropic.Tool => {
        // TODO 3.1：调用 tool.parameters.toJSONSchema() 得到 JSON Schema。
        // TODO 3.2：返回 name、description、input_schema；不用 OpenAI 的 function 包装层。
        // input_schema 必须是对象 schema；SDK 要求 type 为字面量 "object"。
        // 如果 schema.type 的类型太宽，先检查 schema.type !== "object" 并抛错，
        // 然后使用 { ...schema, type: "object" }，保留 properties、required 等字段。
        // 不要调用 tool.invoke；这里只转换定义，不执行工具。
        const schema = tool.parameters.toJSONSchema();
        if (schema.type !== "object") {
            throw new Error(`工具 ${tool.name} 的参数 schema 必须是 object`);
        }
        return {
            name: tool.name,
            description: tool.description,
            input_schema: {
                ...schema,
                type: "object",
            },
        };
    });
}

export function parseAnthropicAssistantMessage(message: Anthropic.Message): AssistantMessage {
    const content = message.content.map((anthropicContent): AssistantMessage["content"][number] => {
        switch (anthropicContent.type) {
            case "text":
                // TODO 4.1：返回内部 text block；字段为 type 和 text，保留空字符串。
                return {
                    type: "text",
                    text: anthropicContent.text,
                };
            case "thinking":
                // TODO 4.2：返回 parseAnthropicThinking(anthropicContent) 的结果。
                // SDK signature 存入 _anthropicSignature，后续回传时再还原。
                return parseAnthropicThinking(anthropicContent);
            case "tool_use":
                // TODO 4.3：返回内部 tool_use block，保留 id、name 和 input。
                // SDK 的 anthropicContent.input 是 unknown，内部要求 Record<string, unknown>。
                // 先检查 typeof input === "object"、input !== null、!Array.isArray(input)，
                // 不符合时抛出带 anthropicContent.id 的错误；通过检查后再收窄为 Record<string, unknown>。
                // input 已是解析后的值，不需要 JSON.parse。
                const input = anthropicContent.input;
                if (typeof input === "object" && input !== null && !Array.isArray(input)) {
                    return {
                        type: "tool_use",
                        id: anthropicContent.id,
                        name: anthropicContent.name,
                        input: anthropicContent.input as Record<string, unknown>,
                    };
                }
                throw new Error(
                    `Anthropic SDK 返回 tool_use_id:${anthropicContent.id}类型检查失败`,
                );
            default:
                // SDK 还有 redacted_thinking、服务端工具等类型，本练习暂不支持。
                // 显式报错避免静默丢失内容；以后扩展时再定义对应的内部表示。
                throw new Error(`UNSUPPORTED_CONTENT_BLOCK: ${anthropicContent.type}`);
        }
    });

    // 示例：按本节约定映射 provider usage，不按文本长度估算 token。
    const promptTokens = message.usage.input_tokens;
    const completionTokens = message.usage.output_tokens;
    return {
        role: "assistant",
        content,
        usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
        },
    };
}
