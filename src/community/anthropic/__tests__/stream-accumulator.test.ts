import { describe, expect, test } from "bun:test";

import { StreamAccumulator } from "../stream-accumulator";
import type { AnthropicThinkingContent } from "../utils";

describe("Anthropic StreamAccumulator", () => {
    test("keeps block index order while accumulating deltas", () => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ index: 1, type: "text_delta", text: "answer" });
        accumulator.push({ index: 0, type: "thinking_start", thinking: "", signature: "" });
        accumulator.push({ index: 0, type: "thinking_delta", thinking: "plan" });
        accumulator.push({ index: 0, type: "signature_delta", signature: "opaque-signature" });
        accumulator.push({
            index: 2,
            type: "tool_start",
            id: "call-1",
            name: "read_file",
        });
        accumulator.push({ index: 2, type: "input_json_delta", partialJson: '{"path"' });
        accumulator.push({ index: 2, type: "input_json_delta", partialJson: ':"a.ts"}' });

        const thinking: AnthropicThinkingContent = {
            type: "thinking",
            thinking: "plan",
            _anthropicSignature: "opaque-signature",
        };
        expect(accumulator.snapshot().content).toEqual([
            thinking,
            { type: "text", text: "answer" },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ]);
    });

    test("keeps signatures on their own blocks and leaves earlier snapshots unchanged", () => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ type: "thinking_start", index: 0, thinking: "first", signature: "" });
        const first = accumulator.snapshot();
        const originalFirst = structuredClone(first);
        accumulator.push({ type: "signature_delta", index: 0, signature: "opaque-a" });
        accumulator.push({
            type: "thinking_start",
            index: 2,
            thinking: "second",
            signature: "opaque-b",
        });
        accumulator.push({ type: "thinking_delta", index: 2, thinking: " plan" });

        const final = accumulator.snapshot();
        const expected: AnthropicThinkingContent[] = [
            { type: "thinking", thinking: "first", _anthropicSignature: "opaque-a" },
            { type: "thinking", thinking: "second plan", _anthropicSignature: "opaque-b" },
        ];
        expect(final.content).toEqual(expected);
        expect(first).toEqual(originalFirst);
        const originalFinal = structuredClone(final);
        const thinking = final.content[0];
        if (thinking?.type !== "thinking") throw new Error("Expected thinking");
        thinking.thinking = "changed by caller";
        expect(accumulator.snapshot()).toEqual(originalFinal);
    });

    test("keeps a signature-only thinking block without thinking deltas", () => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ type: "thinking_start", index: 0, thinking: "", signature: "" });
        accumulator.push({
            type: "signature_delta",
            index: 0,
            signature: "opaque-empty-signature",
        });

        const expected: AnthropicThinkingContent[] = [
            { type: "thinking", thinking: "", _anthropicSignature: "opaque-empty-signature" },
        ];
        expect(accumulator.snapshot().content).toEqual(expected);
    });

    test("combines input and output token usage", () => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ type: "message_start", inputTokens: 12 });
        accumulator.push({ type: "message_end", outputTokens: 4 });

        expect(accumulator.snapshot().usage).toEqual({
            promptTokens: 12,
            completionTokens: 4,
            totalTokens: 16,
        });
    });

    test.each([
        "42",
        "-7",
        "1.5",
        "true",
        "0",
        "false",
        "null",
        "[]",
        '[{"path":"a.ts"}]',
        '"hello"',
        '""',
    ])("uses an object placeholder for non-object tool JSON: %s", (partialJson) => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
        accumulator.push({ type: "input_json_delta", index: 0, partialJson });

        expect(accumulator.snapshot().content).toEqual([
            { type: "tool_use", id: "call-1", name: "read_file", input: {} },
        ]);
    });

    test.each(["", "   ", '{"path":', "not-json"])(
        "uses an object placeholder for empty, incomplete or malformed tool JSON: %s",
        (partialJson) => {
            const accumulator = new StreamAccumulator();
            accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
            accumulator.push({ type: "input_json_delta", index: 0, partialJson });

            expect(accumulator.snapshot().content).toEqual([
                { type: "tool_use", id: "call-1", name: "read_file", input: {} },
            ]);
        },
    );

    test.each([
        { label: "empty object", input: {} },
        {
            label: "object containing numbers, booleans, null and arrays",
            input: { count: 42, enabled: true, optional: null, nested: { values: [1, false] } },
        },
    ])("preserves valid tool input: $label", ({ input }) => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
        accumulator.push({
            type: "input_json_delta",
            index: 0,
            partialJson: JSON.stringify(input),
        });

        // 只限制参数的顶层类型；对象内部的数字、布尔值和数组都是有效 JSON 值。
        expect(accumulator.snapshot().content).toEqual([
            { type: "tool_use", id: "call-1", name: "read_file", input },
        ]);
    });

    test("replaces an incomplete input placeholder without changing the previous snapshot", () => {
        const accumulator = new StreamAccumulator();
        accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
        accumulator.push({ type: "input_json_delta", index: 0, partialJson: '{"path":' });
        const partial = accumulator.snapshot();
        expect(partial.content).toEqual([
            { type: "tool_use", id: "call-1", name: "read_file", input: {} },
        ]);
        const originalPartial = structuredClone(partial);

        accumulator.push({ type: "input_json_delta", index: 0, partialJson: '"a.ts"}' });
        expect(accumulator.snapshot().content).toEqual([
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ]);
        expect(partial).toEqual(originalPartial);
    });
});
