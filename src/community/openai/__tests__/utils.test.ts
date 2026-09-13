import { describe, expect, test } from "bun:test";

import type { Message } from "@/foundation/messages";

import {
  convertToOpenAIMessages,
  parseOpenAIAssistantMessage,
} from "../utils";

describe("OpenAI protocol conversion", () => {
  test("preserves user text/image block order, URLs and optional image detail", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be concise" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect the first image" },
          {
            type: "image_url",
            image_url: { url: "https://example.test/a.png", detail: "high" },
          },
          { type: "text", text: "then compare the second image" },
          { type: "image_url", image_url: { url: "https://example.test/b.png" } },
        ],
      },
    ];
    const originalMessages = structuredClone(messages);

    expect(convertToOpenAIMessages(messages)).toEqual([
      { role: "system", content: "Be concise" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect the first image" },
          {
            type: "image_url",
            image_url: { url: "https://example.test/a.png", detail: "high" },
          },
          { type: "text", text: "then compare the second image" },
          { type: "image_url", image_url: { url: "https://example.test/b.png" } },
        ],
      },
    ]);
    expect(messages).toEqual(originalMessages);
  });

  test("does not turn assistant thinking into visible text and preserves tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private plan: inspect the file first" },
          { type: "text", text: "I will inspect the file" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const originalMessages = structuredClone(messages);
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    const assistant = result[0];
    if (assistant?.role !== "assistant") {
      throw new Error("Expected an assistant message");
    }

    // SDK accepts either a string or text blocks; neither may contain thinking.
    const visibleText = typeof assistant.content === "string"
      ? assistant.content
      : (assistant.content ?? [])
          .map((part) => part.type === "text" ? part.text : "")
          .join("");

    expect(visibleText).toBe("I will inspect the file");
    expect(assistant.tool_calls).toEqual([
      {
        type: "function",
        id: "call-1",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(messages).toEqual(originalMessages);
  });

  test("preserves historical thinking in the reasoning_content field", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect first" },
          { type: "text", text: "I will inspect the file" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const originalMessages = structuredClone(messages);
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "inspect first",
      tool_calls: [
        { id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    });
    expect(messages).toEqual(originalMessages);
  });

  test("keeps text and multiple tool calls in one assistant message", () => {
    const result = convertToOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect both files" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "call-2", name: "read_file", input: { path: "b.ts" } },
        ],
      },
    ]);

    expect(result[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "call-2", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
      ],
    });
  });

  test("expands tool results and preserves their call ids", () => {
    const result = convertToOpenAIMessages([
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "A" },
          { type: "tool_result", tool_use_id: "call-2", content: "B" },
        ],
      },
    ]);

    expect(result).toMatchObject([
      { role: "tool", tool_call_id: "call-1", content: "A" },
      { role: "tool", tool_call_id: "call-2", content: "B" },
    ]);
  });

  test("parses reasoning, empty text and tool arguments", () => {
    const result = parseOpenAIAssistantMessage({
      role: "assistant",
      content: "",
      reasoning_content: "inspect first",
      tool_calls: [
        {
          type: "function",
          id: "call-1",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    } as never);

    expect(result.content).toEqual([
      { type: "thinking", thinking: "inspect first" },
      { type: "text", text: "" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(result.usage).toBeUndefined();
  });

  test("does not create an empty text block for null content with a tool call", () => {
    const result = parseOpenAIAssistantMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          type: "function",
          id: "call-1",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    } as never);

    expect(result.content).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  test("reports malformed final tool arguments with the call id", () => {
    expect(() =>
      parseOpenAIAssistantMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            id: "broken-call",
            function: { name: "read_file", arguments: '{"path"' },
          },
        ],
      } as never),
    ).toThrow("broken-call");
  });
});