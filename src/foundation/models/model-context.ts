import type { NonSystemMessage } from "@/foundation/messages";

export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  signal?: AbortSignal;
}