import { describe, expect, test } from "bun:test";

import type { Message } from "../types";
import { formatTranscript } from "../transcript";

describe("formatTranscript", () => {
  test("formats text messages", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be concise" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    expect(formatTranscript(messages)).toBe(
      ["system: Be concise", "user: Hello", "assistant: Hi"].join("\n"),
    );
  });

  test("keeps tool call correlation ids visible", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "weather", input: { city: "北京" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "晴，26°C" }],
      },
    ];

    expect(formatTranscript(messages)).toContain(
      'assistant.tool_use[call-1]: weather {"city":"北京"}',
    );
    expect(formatTranscript(messages)).toContain("tool.tool_result[call-1]: 晴，26°C");
  });

  test("formats every current content variant", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/map.png", detail: "low" } },
        ],
      },
      { role: "assistant", content: [{ type: "thinking", thinking: "Need a weather tool" }] },
    ];

    expect(formatTranscript(messages)).toBe(
      [
        "user.image_url: https://example.com/map.png",
        "assistant.thinking: Need a weather tool",
      ].join("\n"),
    );
  });
});