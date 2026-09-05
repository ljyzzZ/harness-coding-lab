import type { AssistantMessage, Message } from "@/foundation/messages";
import type { Tool } from "../tools";

export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
}