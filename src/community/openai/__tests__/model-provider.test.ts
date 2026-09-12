import { describe, expect, test } from "bun:test";

import { OpenAIModelProvider } from "../model-provider";

describe("OpenAIModelProvider", () => {
  test("passes signal, tools and caller overrides to the SDK", async () => {
    let request: Record<string, unknown> | undefined;
    let sdkSignal: AbortSignal | undefined;
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
            request = body;
            sdkSignal = options.signal;
            return {
              choices: [{ message: { role: "assistant", content: "ok" } }],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            };
          },
        },
      },
    };
    const controller = new AbortController();
    const provider = new OpenAIModelProvider({ client: client as never });

    const result = await provider.invoke({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      options: { temperature: 0.25 },
      signal: controller.signal,
    });

    expect(request).toMatchObject({
      model: "test-model",
      temperature: 0.25,
    });
    expect(sdkSignal).toBe(controller.signal);
    expect(result).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { totalTokens: 4 },
    });
  });
});

test("streams cumulative snapshots and keeps usage-only chunks", async () => {
  let request: Record<string, unknown> | undefined;
  let sdkSignal: AbortSignal | undefined;
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
          request = body;
          sdkSignal = options.signal;
          return (async function* () {
            yield { choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] };
            yield { choices: [{ index: 0, delta: { content: "lo" } }] };
            yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            yield {
              choices: [],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            };
          })();
        },
      },
    },
  };
  const controller = new AbortController();
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    signal: controller.signal,
  })) {
    snapshots.push(snapshot);
  }

  expect(request).toMatchObject({
    model: "test-model",
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(sdkSignal).toBe(controller.signal);
  expect(snapshots[0]?.content).toEqual([{ type: "text", text: "hel" }]);
  expect(snapshots.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  });
});

test("accumulates reasoning_content separately from text", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ index: 0, delta: { reasoning_content: "先分析" } }] };
          yield {
            choices: [{ index: 0, delta: { reasoning_content: "再回答", content: "hel" } }],
          };
          yield { choices: [{ index: 0, delta: { content: "lo" } }] };
        })(),
      },
    },
  };
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
    snapshots.push(snapshot);
  }

  expect(snapshots.map((snapshot) => snapshot.content)).toEqual([
    [{ type: "thinking", thinking: "先分析" }],
    [
      { type: "thinking", thinking: "先分析再回答" },
      { type: "text", text: "hel" },
    ],
    [
      { type: "thinking", thinking: "先分析再回答" },
      { type: "text", text: "hello" },
    ],
  ]);
  expect(snapshots.at(-1)?.usage).toBeUndefined();
});

test("maps SDK function fields to tool name and input before usage arrives", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield {
            choices: [{ index: 0, delta: { tool_calls: [{
              index: 0,
              id: "call-read",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            }] } }],
          };
        })(),
      },
    },
  };
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
    snapshots.push(snapshot);
  }

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.content).toEqual([
    { type: "tool_use", id: "call-read", name: "read_file", input: { path: "a.ts" } },
  ]);
  expect(snapshots[0]?.usage).toBeUndefined();
});

test("handles all tool fragments per chunk without mixing calls or repeating text", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield {
            choices: [{ index: 0, delta: {
              content: "读取",
              reasoning_content: "检查",
              tool_calls: [
                {
                  index: 1, id: "call-b", type: "function",
                  function: { name: "write_file", arguments: '{"path":"b.ts",' },
                },
                {
                  index: 0, id: "call-a", type: "function",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            } }],
          };
          yield {
            choices: [{ index: 0, delta: {
              content: "完成",
              reasoning_content: "文件",
              tool_calls: [
                { index: 0, function: { arguments: '"a.ts"}' } },
                { index: 1, function: { arguments: '"content":"ok"}' } },
              ],
            } }],
          };
        })(),
      },
    },
  };
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
    snapshots.push(snapshot);
  }

  expect(snapshots.map((snapshot) => snapshot.content)).toEqual([
    [
      { type: "thinking", thinking: "检查" },
      { type: "text", text: "读取" },
    ],
    [
      { type: "thinking", thinking: "检查文件" },
      { type: "text", text: "读取完成" },
      { type: "tool_use", id: "call-a", name: "read_file", input: { path: "a.ts" } },
      {
        type: "tool_use", id: "call-b", name: "write_file",
        input: { path: "b.ts", content: "ok" },
      },
    ],
  ]);
});