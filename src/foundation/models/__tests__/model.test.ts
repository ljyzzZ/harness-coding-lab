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

  async function collectSnapshots(provider: ScriptedModelProvider): Promise<AssistantMessage[]> {
  const snapshots: AssistantMessage[] = [];
  for await (const snapshot of provider.stream({ model: "scripted", messages: [] })) {
    snapshots.push(snapshot);
  }
  return snapshots;
}

test("streams thinking, tool_use and text without losing earlier blocks", async () => {
  const response: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "查🤔" },
      {
        type: "tool_use", id: "call-1", name: "get_weather",
        input: { city: "上海", days: 2, options: { units: "celsius" } },
      },
      { type: "text", text: "好🌤" },
    ],
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
  };
  const snapshots = await collectSnapshots(new ScriptedModelProvider({ responses: [response] }));
  const invoked = await new ScriptedModelProvider({ responses: [response] })
    .invoke({ model: "scripted", messages: [] });

  expect(snapshots[0]?.content).toEqual([{ type: "thinking", thinking: "查" }]);
  expect(snapshots.some((snapshot) => snapshot.content.some(
    (item) => item.type === "tool_use" && item.name === "g" && item.id === "call-1",
  ))).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.content.some(
    (item) => item.type === "tool_use" && item.input.city === "上",
  ))).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.content.some(
    (item) => item.type === "text" && item.text === "好",
  ))).toBe(true);
  for (const snapshot of snapshots) {
    if (snapshot.content.length >= 2) expect(snapshot.content[0]).toEqual(response.content[0]);
    if (snapshot.content.length === 3) expect(snapshot.content[1]).toEqual(response.content[1]);
  }
  expect(snapshots.at(-1)).toEqual(invoked);
});

test("emits a final snapshot for empty content and empty blocks", async () => {
  const contents: AssistantMessage["content"][] = [
    [],
    [{ type: "text", text: "" }],
    [{ type: "thinking", thinking: "" }],
    [{ type: "tool_use", id: "empty", name: "noop", input: {} }],
    [
      { type: "thinking", thinking: "" },
      { type: "tool_use", id: "empty", name: "noop", input: { value: "", enabled: false, data: null, items: [] } },
      { type: "text", text: "" },
    ],
  ];
  for (const content of contents) {
    const response: AssistantMessage = { role: "assistant", content };
    const snapshots = await collectSnapshots(new ScriptedModelProvider({ responses: [response] }));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toEqual(response);
  }
});

test("isolates snapshots from consumers and the original script", async () => {
  const response: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "tool_use", id: "call-1", name: "go", input: { nested: { value: 1 }, city: "上海" } },
      { type: "text", text: "完成" },
    ],
  };
  const expected = structuredClone(response);
  const provider = new ScriptedModelProvider({ responses: [response] });
  response.content.length = 0;
  const stream = provider.stream({ model: "scripted", messages: [] });
  for await (const snapshot of stream) {
    const item = snapshot.content[0];
    if (item?.type === "tool_use" && item.input.nested) {
      Object.assign(item.input.nested, { value: 99 });
      item.name = "changed";
      snapshot.content.length = 0;
      // 此时后面还有 city 和 text；继续读取，验证它们未受修改影响。
      let final: AssistantMessage | undefined;
      for await (const remaining of stream) final = remaining;
      expect(final).toEqual(expected);
      return;
    }
  }
  throw new Error("Expected an intermediate snapshot containing nested input");
});

test("checks abort before consuming a response and between snapshots", async () => {
  const first: AssistantMessage = { role: "assistant", content: [{ type: "thinking", thinking: "想一想" }] };
  const second: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "next" }] };
  const provider = new ScriptedModelProvider({ responses: [first, second] });
  const aborted = new AbortController();
  aborted.abort();
  const stopped = provider.stream({ model: "scripted", messages: [], signal: aborted.signal });
  await expect(stopped.next()).rejects.toBeDefined();

  const controller = new AbortController();
  const stream = provider.stream({ model: "scripted", messages: [], signal: controller.signal });
  const start = await stream.next();
  expect(start.value?.content[0]).toEqual({ type: "thinking", thinking: "想" });
  controller.abort();
  await expect(stream.next()).rejects.toBeDefined();
  expect(await provider.invoke({ model: "scripted", messages: [] })).toEqual(second);
});
});