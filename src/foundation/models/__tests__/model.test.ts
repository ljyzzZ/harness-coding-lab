import { describe, expect, test } from "bun:test";

import type { AssistantMessage } from "@/foundation/messages";

import { Model } from "../model";
import type { ModelProvider, ModelProviderInvokeParams } from "../model-provider";
import { ScriptedModelProvider } from "../scripted-model-provider";

class RecordingProvider implements ModelProvider {
  params?: ModelProviderInvokeParams;

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.params = params;
    return { role: "assistant", content: [{ type: "text", text: "ok" }] };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.params = params;
    yield { role: "assistant", content: [{ type: "text", text: "ok" }] };
  }
}

const RESPONSE: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
};

async function collectText(provider: ScriptedModelProvider): Promise<string[]> {
  const snapshots: string[] = [];
  for await (const message of provider.stream({ model: "scripted", messages: [] })) {
    const text = message.content.find((item) => item.type === "text");
    if (text?.type === "text") snapshots.push(text.text);
  }
  return snapshots;
}

describe("Model", () => {
  test("prepends a system message without storing it in transcript", async () => {
    const provider = new RecordingProvider();
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
    const model = new Model({ name: "recording", provider });

    await model.invoke({ prompt: "Be concise", messages });

    expect(provider.params?.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "Be concise" }],
    });
    expect(messages).toHaveLength(1);
  });

  test("stream yields cumulative snapshots", async () => {
    const provider = new ScriptedModelProvider({ responses: [RESPONSE] });
    expect(await collectText(provider)).toEqual(["h", "he", "hel", "hell", "hello"]);
  });

  test("the final stream snapshot equals invoke result", async () => {
    const invokeProvider = new ScriptedModelProvider({ responses: [RESPONSE] });
    const streamProvider = new ScriptedModelProvider({ responses: [RESPONSE] });
    const invoked = await invokeProvider.invoke({ model: "scripted", messages: [] });
    let streamed: AssistantMessage | undefined;

    for await (const snapshot of streamProvider.stream({ model: "scripted", messages: [] })) {
      streamed = snapshot;
    }

    expect(streamed).toEqual(invoked);
  });

  test("passes AbortSignal to provider", async () => {
    const provider = new RecordingProvider();
    const model = new Model({ name: "recording", provider });
    const controller = new AbortController();

    await model.invoke({ prompt: "", messages: [], signal: controller.signal });

    expect(provider.params?.signal).toBe(controller.signal);
  });
});