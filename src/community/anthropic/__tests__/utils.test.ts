import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";

import type { Message } from "@/foundation/messages";

import type { AnthropicThinkingContent } from "../utils";
import {
    convertToAnthropicMessages,
    extractSystemPrompt,
    parseAnthropicAssistantMessage,
} from "../utils";

describe("Anthropic protocol conversion", () => {
    test("extracts system text separately and excludes it from messages", () => {
        const messages: Message[] = [
            { role: "system", content: [{ type: "text", text: "Rule A" }] },
            { role: "system", content: [{ type: "text", text: "Rule B" }] },
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        expect(extractSystemPrompt(messages)).toBe("Rule A\n\nRule B");
        expect(convertToAnthropicMessages(messages)).toMatchObject([
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ]);
    });

    test("round-trips thinking signatures and multiple tool calls without changing history", () => {
        const content: Anthropic.ContentBlockParam[] = [
            { type: "thinking", thinking: "plan", signature: "opaque-signature-a" },
            { type: "text", text: "running" },
            { type: "thinking", thinking: "verify", signature: "opaque-signature-b" },
            { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
            { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
        ];
        const response = {
            role: "assistant",
            content,
            usage: { input_tokens: 8, output_tokens: 5 },
        };
        const originalResponse = structuredClone(response);
        const assistant = parseAnthropicAssistantMessage(response as never);
        const messages: Message[] = [
            assistant,
            {
                role: "tool",
                content: [
                    { type: "tool_result", tool_use_id: "a", content: "file A" },
                    { type: "tool_result", tool_use_id: "b", content: "file B" },
                ],
            },
        ];
        const originalMessages = structuredClone(messages);

        expect(convertToAnthropicMessages(messages)).toEqual([
            { role: "assistant", content },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "a", content: "file A" },
                    { type: "tool_result", tool_use_id: "b", content: "file B" },
                ],
            },
        ]);
        expect(response).toEqual(originalResponse);
        expect(messages).toEqual(originalMessages);
    });

    test("preserves signed thinking even when its text is empty", () => {
        const assistant = parseAnthropicAssistantMessage({
            role: "assistant",
            content: [{ type: "thinking", thinking: "", signature: "opaque-empty-signature" }],
            usage: { input_tokens: 1, output_tokens: 2 },
        } as never);

        const expected: AnthropicThinkingContent[] = [
            { type: "thinking", thinking: "", _anthropicSignature: "opaque-empty-signature" },
        ];
        expect(assistant.content).toEqual(expected);
        expect(convertToAnthropicMessages([assistant])).toEqual([
            {
                role: "assistant",
                content: [{ type: "thinking", thinking: "", signature: "opaque-empty-signature" }],
            },
        ]);
    });

    test("rejects replaying thinking without a signature", () => {
        expect(() =>
            convertToAnthropicMessages([
                {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "plan" }],
                },
            ]),
        ).toThrow("MISSING_THINKING_SIGNATURE");
    });

    test("keeps empty text blocks when parsing a response", () => {
        const result = parseAnthropicAssistantMessage({
            role: "assistant",
            content: [{ type: "text", text: "" }],
            usage: { input_tokens: 1, output_tokens: 0 },
        } as never);

        expect(result.content).toEqual([{ type: "text", text: "" }]);
    });

    test("converts tool results into user-role content", () => {
        expect(
            convertToAnthropicMessages([
                {
                    role: "tool",
                    content: [{ type: "tool_result", tool_use_id: "a", content: "result" }],
                },
            ]),
        ).toMatchObject([
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "a", content: "result" }],
            },
        ]);
    });

    test("parses text, thinking, tool use and usage", () => {
        const result = parseAnthropicAssistantMessage({
            id: "message-1",
            type: "message",
            role: "assistant",
            model: "test-model",
            stop_reason: "tool_use",
            content: [
                { type: "thinking", thinking: "plan", signature: "signature" },
                { type: "text", text: "running" },
                { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
            ],
            usage: { input_tokens: 8, output_tokens: 5 },
        } as never);

        expect(result.content).toMatchObject([
            { type: "thinking", thinking: "plan", _anthropicSignature: "signature" },
            { type: "text", text: "running" },
            { type: "tool_use", id: "a", input: { path: "a.ts" } },
        ]);
        expect(result.usage).toEqual({ promptTokens: 8, completionTokens: 5, totalTokens: 13 });
    });
});
