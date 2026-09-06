import type { AssistantMessage, ToolMessage } from "@/foundation/messages";

export type AgentEvent =
  | { type: "message"; message: AssistantMessage | ToolMessage }
  | { type: "progress"; subtype: "thinking" }
  | { type: "progress"; subtype: "tool"; name: string; input: unknown };