import type { NonSystemMessage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface AgentContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
}