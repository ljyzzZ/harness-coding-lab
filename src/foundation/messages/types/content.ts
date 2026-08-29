export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageURLContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "high" | "low";
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_use";
  id: string;
  name: string;
  input: T;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

// 标准实现示例：system message 只接受文本块。
export type SystemMessageContent = TextContent[];

// TODO 1：用户可以发送文本或图片。
// 提示：写成由 TextContent 和 ImageURLContent 组成的数组元素 union。
export type UserMessageContent = (TextContent | ImageURLContent)[];

// TODO 2：assistant 可以输出文本、thinking 或发起 Tool call。
// 提示：不要加入 ToolResultContent；Tool result 只属于 role="tool"。
export type AssistantMessageContent = (TextContent | ThinkingContent | ToolUseContent)[];

// TODO 3：Tool message 只承载 ToolResultContent 数组。
export type ToolMessageContent = ToolResultContent[];

// formatter 等跨角色工具使用的穷尽 union；这里给出完整实现。
export type MessageContent =
  | TextContent
  | ImageURLContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent;