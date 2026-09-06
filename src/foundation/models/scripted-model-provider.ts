import type { AssistantMessage } from "@/foundation/messages";

import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

type AssistantContent = AssistantMessage["content"][number];

function* textPrefixes(text: string): Generator<string> {
  let accumulated = "";
  if (text.length === 0) yield accumulated;
  for (const character of text) {
    accumulated += character;
    yield accumulated;
  }
}

function* contentSnapshots(content: AssistantContent): Generator<AssistantContent> {
  if (content.type === "text") {
    for (const text of textPrefixes(content.text)) yield { ...content, text };
  } else if (content.type === "thinking") {
    for (const thinking of textPrefixes(content.thinking)) yield { ...content, thinking };
  } else {
    for (const name of textPrefixes(content.name)) yield { ...content, name, input: {} };

    let input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(content.input)) {
      if (typeof value === "string") {
        for (const prefix of textPrefixes(value)) {
          yield { ...content, input: { ...input, [key]: prefix } };
        }
      } else {
        yield { ...content, input: { ...input, [key]: value } };
      }
      input = { ...input, [key]: value };
    }
  }
}

export class ScriptedModelProvider implements ModelProvider {
  private readonly _responses: AssistantMessage[];
  private _cursor = 0;

  constructor({ responses }: { responses: AssistantMessage[] }) {
    this._responses = structuredClone(responses);
  }

  async invoke({ signal }: ModelProviderInvokeParams): Promise<AssistantMessage> {
    return this._nextResponse(signal);
  }

  async *stream({ signal }: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = this._nextResponse(signal);
    const completed: AssistantContent[] = [];
    let pending: AssistantMessage | undefined;

    for (const content of response.content) {
      for (const partial of contentSnapshots(content)) {
        signal?.throwIfAborted();
        // 向前看一个快照，避免额外重复发送最后一个完整快照。
        if (pending) yield pending;
        pending = { role: "assistant", content: structuredClone([...completed, partial]) };
      }
      completed.push(content);
    }
    signal?.throwIfAborted();
    yield response;
  }

  private _nextResponse(signal?: AbortSignal): AssistantMessage {
    signal?.throwIfAborted();
    const response = this._responses[this._cursor];
    if (!response) {
      throw new Error("ScriptedModelProvider has no response left");
    }
    this._cursor += 1;
    return structuredClone(response);
  }
}