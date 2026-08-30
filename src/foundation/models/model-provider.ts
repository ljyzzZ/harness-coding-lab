import type { AssistantMessage, Message } from "@/foundation/messages";

export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
}