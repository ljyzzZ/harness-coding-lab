import { describe, expect, test } from "bun:test";

import type { AssistantMessageContent, ToolUseContent } from "@/foundation/messages";

import { StreamAccumulator } from "../stream-accumulator";

describe("OpenAI StreamAccumulator", () => {
  test("omits empty content and leaves absent usage undefined", () => {
    const accumulator = new StreamAccumulator();
    expect(accumulator.snapshot().content).toEqual([]);
    accumulator.push({});
    accumulator.push({ textDelta: "", thinkingDelta: "" });

    expect(accumulator.snapshot().role).toBe("assistant");
    expect(accumulator.snapshot().content).toEqual([]);
    expect(accumulator.snapshot().usage).toBeUndefined();
  });

  test("accumulates thinking and emits thinking before text and tools", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      textDelta: "answer",
      thinkingDelta: "think",
      toolCall: { index: 0, id: "a", name: "read_file", argumentsDelta: "{}" },
    });
    const first = accumulator.snapshot();
    accumulator.push({ thinkingDelta: " more", textDelta: "!" });

    expect(first.content).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "a", name: "read_file", input: {} },
    ]);
    expect(accumulator.snapshot().content).toEqual([
      { type: "thinking", thinking: "think more" },
      { type: "text", text: "answer!" },
      { type: "tool_use", id: "a", name: "read_file", input: {} },
    ]);
  });

  test("accumulates text and usage into independent snapshots", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ textDelta: "hel" });
    const first = accumulator.snapshot();
    accumulator.push({ textDelta: "lo" });
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });

    expect(first.content).toEqual([{ type: "text", text: "hel" }]);
    expect(accumulator.snapshot()).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      usage: { totalTokens: 5 },
    });
  });

  test("joins fragmented JSON without mixing concurrent tool calls", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      toolCall: { index: 10, id: "a", name: "read_file", argumentsDelta: '{"path":"b' },
    });
    accumulator.push({
      toolCall: { index: 2, id: "z", name: "read_file", argumentsDelta: '{"path":"/tmp/' },
    });
    accumulator.push({ toolCall: { index: 10, argumentsDelta: '.ts"}' } });
    accumulator.push({ toolCall: { index: 2, argumentsDelta: 'demo","line":1}' } });

    expect(accumulator.snapshot().content).toEqual([
      {
        type: "tool_use",
        id: "z",
        name: "read_file",
        input: { path: "/tmp/demo", line: 1 },
      },
      { type: "tool_use", id: "a", name: "read_file", input: { path: "b.ts" } },
    ]);
  });

  test("does not expose mutable accumulator state", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ textDelta: "safe" });
    const snapshot = accumulator.snapshot();
    snapshot.content.splice(0);

    expect(accumulator.snapshot().content).toEqual([{ type: "text", text: "safe" }]);
  });

  test("withholds only incomplete calls and exposes them once JSON is complete", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      toolCall: { index: 1, id: "b", name: "read_file", argumentsDelta: '{"path":"b.ts"}' },
    });
    accumulator.push({
      toolCall: { index: 0, id: "a", name: "read_file", argumentsDelta: '{"path":"/tmp/' },
    });
    const partial = accumulator.snapshot();
    expect(partial.content).toEqual([
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
    expect(accumulator.snapshot().content).toEqual(partial.content);

    accumulator.push({ toolCall: { index: 0, argumentsDelta: 'demo"}' } });
    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "a", name: "read_file", input: { path: "/tmp/demo" } },
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
    expect(partial.content).toEqual([
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
    expect(accumulator.snapshot().usage).toBeUndefined();
  });

  test("falls back only for invalid arguments after receiving usage, including zero usage", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ toolCall: { index: 2, id: "empty", name: "read_file" } });
    accumulator.push({
      toolCall: { index: 1, id: "broken", name: "read_file", argumentsDelta: '{"path":' },
    });
    accumulator.push({
      toolCall: { index: 0, id: "valid", name: "read_file", argumentsDelta: '{"path":"a.ts"}' },
    });
    const valid: ToolUseContent = { type: "tool_use", id: "valid", name: "read_file", input: { path: "a.ts" } };
    expect(accumulator.snapshot().content).toEqual([valid]);

    accumulator.push({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect(accumulator.snapshot().content).toEqual([
      valid,
      { type: "tool_use", id: "broken", name: "read_file", input: {} },
      { type: "tool_use", id: "empty", name: "read_file", input: {} },
    ]);
    expect(accumulator.snapshot().usage).toEqual({
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
    });
  });

  test("merges metadata arriving after arguments and preserves it across later fragments", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ toolCall: { index: 3, argumentsDelta: '{"path":' } });
    accumulator.push({ toolCall: { index: 3, id: "a", name: "read_file" } });
    accumulator.push({ toolCall: { index: 3, id: "a", name: "read_file", argumentsDelta: '"a.ts"}' } });
    accumulator.push({ toolCall: { index: 3, argumentsDelta: "" } });

    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  test("replaces usage when reported and preserves it when a chunk omits it", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } });
    const first = accumulator.snapshot();
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
    accumulator.push({});

    expect(first.usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
    expect(accumulator.snapshot().usage).toEqual({
      promptTokens: 3, completionTokens: 2, totalTokens: 5,
    });
  });

  test("isolates content objects, nested tool input and usage between snapshots", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      thinkingDelta: "think",
      textDelta: "safe",
      toolCall: {
        index: 0, id: "a", name: "read_file",
        argumentsDelta: '{"options":{"paths":["a.ts"]}}',
      },
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
    const first = accumulator.snapshot();
    const second = accumulator.snapshot();
    for (const item of first.content) {
      if (item.type === "thinking") item.thinking = "changed";
      if (item.type === "text") item.text = "changed";
      if (item.type === "tool_use") {
        item.id = "changed";
        item.name = "changed";
        const options = item.input.options as { paths: string[] };
        options.paths.push("changed.ts");
      }
    }
    first.usage!.totalTokens = 999;

    const expectedContent: AssistantMessageContent = [
      { type: "thinking", thinking: "think" },
      { type: "text", text: "safe" },
      { type: "tool_use", id: "a", name: "read_file", input: { options: { paths: ["a.ts"] } } },
    ];
    expect(second.content).toEqual(expectedContent);
    expect(accumulator.snapshot().content).toEqual(expectedContent);
    expect(second.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(accumulator.snapshot().usage).toEqual(second.usage);
  });
});