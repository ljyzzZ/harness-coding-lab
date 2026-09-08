import OpenAI from "openai";

import type { AssistantMessage, AssistantMessageContent, Message, TokenUsage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";
import { text } from "node:stream/consumers";
import type { ChatCompletionContentPartText, ChatCompletionMessageToolCall } from "openai/resources";
import { url } from "node:inspector";

export function convertToOpenAIMessages(
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        // 标准路径：逐条转换，结果只写入新数组，不修改 canonical transcript。
        result.push({ role: "system", content: message.content.map((item) => item.text).join("\n") });
        break;
      case "user":
        // TODO 1：map 每个 text/image_url block；保持数组顺序，图片保留 URL/detail。
        result.push({
          role: "user", content: message.content.map((item) => {
            if (item.type === "text") {
              return {
                type: "text",
                text: item.text,
              };
            } else {
              return {
                type: "image_url",
                image_url: {
                  url: item.image_url.url,
                  detail: item.image_url.detail,
                }
              }
            }
          }
          )
        });
        break;
      case "assistant":
        // TODO 2：text 合并为 content，tool_use 合并为同一 wire message 的 tool_calls。
        // arguments 是 JSON.stringify(input)；只有 Tool call 时 content 可为 null。
        // thinking 的回传规则由 endpoint 决定，不能冒充用户文本。
        const content: ChatCompletionContentPartText[] = [];
        const tool_calls: ChatCompletionMessageToolCall[] = [];
        for (const assistantContent of message.content) {
          switch (assistantContent.type) {
            case "text":
              content.push({ type: "text", text: assistantContent.text });
              break;
            case "thinking":
              break;
            case "tool_use":
              tool_calls.push({
                type: "function",
                id: assistantContent.id,
                function: {
                  name: assistantContent.name,
                  arguments: JSON.stringify(assistantContent.input),
                },
              });
              break;
          }
        }
        result.push({
          role: "assistant",
          content: content,
          tool_calls: tool_calls,
        })
        break;
      case "tool":
        // TODO 3：一条 canonical ToolMessage 可生成多条 wire tool message；
        // 每条使用 tool_call_id=tool_use_id。不要用 map 生成嵌套数组。
        for (const toolResult of message.content) {
          result.push({
            role: "tool",
            content: toolResult.content,
            tool_call_id: toolResult.tool_use_id
          })
        }
        break;
    }
  }
  return result;
}

export function convertToOpenAITools(
  tools: Tool[],
): OpenAI.ChatCompletionTool[] {
  // 标准实现示例：schema 转换只发生在 provider adapter。
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters.toJSONSchema(),
    },
  }));
}

export function parseOpenAIAssistantMessage(
  message: OpenAI.ChatCompletionMessage,
  usage?: TokenUsage,
): AssistantMessage {
  const assistantMessageContent: AssistantMessageContent = [];
  // TODO 4：content 转为 text；reasoning_content 转为 thinking（若 endpoint 提供）。
  // TODO 5：tool_calls arguments 用 JSON.parse；最终仍非法时抛出带 call id 的转换错误。
  // TODO 6：usage 缺省时不要伪造 0，保持 AssistantMessage.usage 为 undefined。
  const reasoning = (
    message as OpenAI.ChatCompletionMessage & { reasoning_content?: unknown }
  ).reasoning_content;

  if (typeof reasoning === "string") {
    assistantMessageContent.push({
      type: "thinking",
      thinking: reasoning,
    });
  }
  assistantMessageContent.push({ type: "text", text: message.content ?? "" });
  for (const tool_call of message.tool_calls ?? []) {
    let input: Record<string, unknown>;


    if (tool_call.type === "custom") {
      try {
        input = JSON.parse(tool_call.custom.input);
      } catch (cause) {
        throw new Error(
          `Invalid tool arguments for call ${tool_call.id}`,
          { cause },
        );
      }
      assistantMessageContent.push({
        type: "tool_use",
        id: tool_call.id,
        name: tool_call.custom.name,
        input: input,
      })
    } else {
      try {
        input = JSON.parse(tool_call.function.arguments);
      } catch (cause) {
        throw new Error(
          `Invalid tool arguments for call ${tool_call.id}`,
          { cause },
        );
      };
      assistantMessageContent.push({
        type: "tool_use",
        id: tool_call.id,
        name: tool_call.function.name,
        input: input,
      })
    }
  }

  return {
    role: "assistant",
    content: assistantMessageContent,
    usage: usage
  };
}