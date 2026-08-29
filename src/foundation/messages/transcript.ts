import type { Message, MessageContent } from "./types";

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

function formatContent(role: Message["role"], content: MessageContent): string {
  switch (content.type) {
    case "text":
      // 标准实现示例：普通文本保留所属 role，便于直接阅读 transcript。
      return `${role}: ${content.text}`;
    case "image_url":
      // TODO 1：返回 `${role}.image_url: ${content.image_url.url}`。
      // detail 是显示参数，不应替换 URL，也不需要下载图片。
      return `${role}.image_url: ${content.image_url.url}`
    case "thinking":
      // TODO 2：返回 `${role}.thinking: ${content.thinking}`。
      return `${role}.thinking: ${content.thinking}`
    case "tool_use":
      // TODO 3：必须显示 id、Tool name 和 JSON input。
      // 固定格式：assistant.tool_use[id]: name {json}
      return `assistant.tool_use[${content.id}]: ${content.name} ${JSON.stringify(content.input)}`
    case "tool_result":
      // TODO 4：必须显示 tool_use_id，固定格式：
      // tool.tool_result[id]: content
      return `tool.tool_result[${content.tool_use_id}]: ${content.content}`
    default:
      return assertNever(content);
  }
}

export function formatTranscript(messages: Message[]): string {
  // TODO 5：保持 messages 及每条 content 的原始顺序；
  // 每个 content block 格式化为一行，最后使用 "\n" 连接。
  // 不要排序，也不要丢弃空 content 数组对应的 message。

  const lines: string[] = []

  for(const message of messages) {
    for(const content of message.content) {
        lines.push(formatContent(message.role, content))
    }
  }

  return lines.join("\n");
}