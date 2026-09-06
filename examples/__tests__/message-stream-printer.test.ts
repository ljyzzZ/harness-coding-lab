import { expect, test } from "bun:test";

import type { AssistantMessage } from "@/foundation/messages";

import { defineMessagePrinter } from "../message-stream-printer";

test("replays complete weather messages incrementally without duplicate lines", async () => {
  const chunks: string[] = [];
  const print = defineMessagePrinter({ write: (text) => { chunks.push(text); } });
  const call: AssistantMessage = {
    role: "assistant",
    content: [{ type: "tool_use", id: "weather-1", name: "get_weather", input: { city: "上海" } }],
  };
  const original = structuredClone(call);
  await print(call);
  expect(call).toEqual(original);
  expect(chunks).toContain("g");
  expect(chunks).toContain("e");
  expect(chunks.join("")).toBe("[assistant/tool_use] get_weather #weather-1\n");

  await print({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "weather-1", content: '{"city":"上海","condition":"晴","temperatureC":26}' }],
  });
  await print({ role: "assistant", content: [{ type: "text", text: "上海今天晴，26°C。" }] });
  expect(chunks).toContain("上");
  expect(chunks).toContain("海");
  expect(chunks.join("")).toBe(
    '[assistant/tool_use] get_weather #weather-1\n' +
    '[tool/tool_result] #weather-1 {"city":"上海","condition":"晴","temperatureC":26}\n' +
    '[assistant] 上海今天晴，26°C。\n',
  );
});

test("keeps mixed blocks, Unicode and consecutive tool calls on separate lines", async () => {
  const chunks: string[] = [];
  const print = defineMessagePrinter({ write: (text) => { chunks.push(text); } });
  await print({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "想🤔" },
      { type: "text", text: "" },
      { type: "tool_use", id: "a", name: "first", input: {} },
      { type: "tool_use", id: "b", name: "second", input: {} },
      { type: "text", text: "好🌤" },
    ],
  });
  await print({ role: "assistant", content: [] });
  expect(chunks).toContain("🤔");
  expect(chunks).toContain("🌤");
  expect(chunks.join("")).toBe(
    "[assistant/thinking] 想🤔\n[assistant] \n" +
    "[assistant/tool_use] first #a\n[assistant/tool_use] second #b\n[assistant] 好🌤\n",
  );
});