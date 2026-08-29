import type {
  AssistantMessageContent,
  SystemMessageContent,
  ToolMessageContent,
  UserMessageContent,
} from "./content";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SystemMessage {
  role: "system";
  content: SystemMessageContent;
}

// 标准实现示例：role 是 discriminator，content 使用对应角色的 union。
export interface UserMessage {
  role: "user";
  content: UserMessageContent;
}

// TODO 1：定义 role="assistant"，content 使用 AssistantMessageContent；
// 再增加可选 usage?: TokenUsage，供 provider 回传 token 统计。
export interface AssistantMessage {
  role: "assistant";
  content: AssistantMessageContent;
  usage?: TokenUsage;
}

// TODO 2：定义 role="tool"，content 使用 ToolMessageContent。
export interface ToolMessage {
  role: "tool";
  content: ToolMessageContent;
}

// TODO 3：这里只包含 user、assistant、tool，不包含 system。
export type NonSystemMessage =
  | UserMessage
  | AssistantMessage
  | ToolMessage;

// TODO 4：Message 是 SystemMessage 与 NonSystemMessage 的 union。
export type Message = SystemMessage | NonSystemMessage;
