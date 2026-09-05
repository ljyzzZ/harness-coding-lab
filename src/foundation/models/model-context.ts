import type { NonSystemMessage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}