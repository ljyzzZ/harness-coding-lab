import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { AssistantMessage } from "@/foundation/messages";

import { AnthropicModelProvider } from "../model-provider";
import type { AnthropicThinkingContent } from "../utils";

describe("AnthropicModelProvider", () => {
    test("separates system and passes caller options and signal to the SDK", async () => {
        let request: Record<string, unknown> | undefined;
        let sdkSignal: AbortSignal | undefined;
        const client = {
            messages: {
                create: async (
                    body: Record<string, unknown>,
                    options: { signal?: AbortSignal },
                ) => {
                    request = body;
                    sdkSignal = options.signal;
                    return {
                        id: "message-1",
                        type: "message",
                        role: "assistant",
                        model: "test-model",
                        content: [{ type: "text", text: "ok" }],
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        usage: { input_tokens: 3, output_tokens: 1 },
                    };
                },
            },
        };
        const controller = new AbortController();
        const provider = new AnthropicModelProvider({ client: client as never });

        const result = await provider.invoke({
            model: "test-model",
            messages: [
                { role: "system", content: [{ type: "text", text: "Be concise" }] },
                { role: "user", content: [{ type: "text", text: "hello" }] },
            ],
            options: { max_tokens: 256 },
            signal: controller.signal,
        });

        expect(request).toMatchObject({
            model: "test-model",
            system: "Be concise",
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            max_tokens: 256,
        });
        expect(request).not.toHaveProperty("signal");
        expect(sdkSignal).toBe(controller.signal);
        expect(result).toMatchObject({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        });
    });
});

test("streams signed thinking and replays it with tool results", async () => {
    let request: Record<string, unknown> | undefined;
    let sdkSignal: AbortSignal | undefined;
    const client = {
        messages: {
            create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
                request = body;
                sdkSignal = options.signal;
                if (!body.stream) {
                    return {
                        id: "message-2",
                        type: "message",
                        role: "assistant",
                        model: "test-model",
                        content: [{ type: "text", text: "done" }],
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        usage: { input_tokens: 5, output_tokens: 1 },
                    };
                }
                return (async function* () {
                    yield {
                        type: "message_start",
                        message: {
                            id: "message-1",
                            type: "message",
                            role: "assistant",
                            model: "test-model",
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 3, output_tokens: 0 },
                        },
                    };
                    yield {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "thinking", thinking: "", signature: "" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "thinking_delta", thinking: "plan" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "signature_delta", signature: "opaque-stream-signature" },
                    };
                    yield { type: "content_block_stop", index: 0 };
                    yield {
                        type: "content_block_start",
                        index: 1,
                        content_block: { type: "text", text: "" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 1,
                        delta: { type: "text_delta", text: "hel" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 1,
                        delta: { type: "text_delta", text: "lo" },
                    };
                    yield { type: "content_block_stop", index: 1 };
                    yield {
                        type: "content_block_start",
                        index: 2,
                        content_block: {
                            type: "tool_use",
                            id: "call-1",
                            name: "read_file",
                            input: {},
                        },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 2,
                        delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
                    };
                    yield { type: "content_block_stop", index: 2 };
                    yield {
                        type: "message_delta",
                        delta: { stop_reason: "tool_use", stop_sequence: null },
                        usage: { output_tokens: 2 },
                    };
                    yield { type: "message_stop" };
                })();
            },
        },
    };
    const controller = new AbortController();
    const provider = new AnthropicModelProvider({ client: client as never });
    const snapshots = [];
    const options = { thinking: { type: "enabled", budget_tokens: 1024 } };

    for await (const snapshot of provider.stream({
        model: "test-model",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        options,
        signal: controller.signal,
    })) {
        snapshots.push(snapshot);
    }

    expect(request).toMatchObject({ model: "test-model", stream: true, ...options });
    expect(sdkSignal).toBe(controller.signal);
    expect(
        snapshots.some((snapshot) =>
            snapshot.content.some((item) => item.type === "text" && item.text === "hel"),
        ),
    ).toBe(true);
    const final = snapshots.at(-1);
    if (!final) throw new Error("Expected a final snapshot");
    expect(final).toMatchObject({
        role: "assistant",
        content: [
            { type: "thinking", thinking: "plan", _anthropicSignature: "opaque-stream-signature" },
            { type: "text", text: "hello" },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });

    await provider.invoke({
        model: "test-model",
        messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            final,
            {
                role: "tool",
                content: [{ type: "tool_result", tool_use_id: "call-1", content: "file A" }],
            },
        ],
        options,
    });
    expect(request?.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "plan", signature: "opaque-stream-signature" },
                { type: "text", text: "hello" },
                { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call-1", content: "file A" }],
        },
    ]);
});

function messageStart(inputTokens = 3, outputTokens = 0) {
    return {
        type: "message_start",
        message: { content: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    };
}

function messageEnd(outputTokens = 2) {
    return [
        { type: "message_delta", usage: { output_tokens: outputTokens } },
        { type: "message_stop" },
    ];
}

function toolEvents(partialJson?: string, initialInput: unknown = {}) {
    return [
        messageStart(),
        {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: "call-invalid",
                name: "read_file",
                input: initialInput,
            },
        },
        ...(partialJson === undefined
            ? []
            : [
                  {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "input_json_delta", partial_json: partialJson },
                  },
              ]),
        { type: "content_block_stop", index: 0 },
        ...messageEnd(),
    ];
}

function defineStreamProvider(events: readonly unknown[]) {
    const client = {
        messages: {
            create: async () =>
                (async function* () {
                    yield* events;
                })(),
        },
    };
    return new AnthropicModelProvider({ client: client as unknown as Anthropic });
}

async function collect(provider: AnthropicModelProvider, signal?: AbortSignal) {
    const snapshots: AssistantMessage[] = [];
    for await (const snapshot of provider.stream({ model: "test-model", messages: [], signal })) {
        snapshots.push(snapshot);
    }
    return snapshots;
}

describe("Anthropic provider boundaries", () => {
    test("converts tool schemas, preserves options and forces the method's stream mode", async () => {
        const requests: Record<string, unknown>[] = [];
        const client = {
            messages: {
                create: async (body: Record<string, unknown>) => {
                    requests.push(body);
                    if (body.stream) {
                        return (async function* () {
                            yield messageStart();
                            yield* messageEnd();
                        })();
                    }
                    return { content: [], usage: { input_tokens: 3, output_tokens: 2 } };
                },
            },
        };
        const provider = new AnthropicModelProvider({ client: client as unknown as Anthropic });
        const parameters = z.object({ path: z.string() });
        const tools = [
            {
                name: "read_file",
                description: "Read a file",
                parameters,
                invoke() {
                    throw new Error("Provider must not execute tools");
                },
            },
        ];
        const options = { stream: true, thinking: { type: "enabled", budget_tokens: 1024 } };
        const originalOptions = structuredClone(options);
        await provider.invoke({ model: "test-model", messages: [], tools, options });
        expect(requests[0]).toMatchObject({
            stream: false,
            max_tokens: 8192,
            thinking: options.thinking,
            tools: [
                {
                    name: "read_file",
                    description: "Read a file",
                    input_schema: parameters.toJSONSchema(),
                },
            ],
        });
        expect(requests[0]?.system).toBeUndefined();
        expect(requests[0]?.temperature).toBeUndefined();
        for await (const _ of provider.stream({
            model: "test-model",
            messages: [],
            tools,
            options: { stream: false, max_tokens: 512 },
        })) {
            /* consume the stream */
        }
        expect(requests[1]).toMatchObject({
            stream: true,
            max_tokens: 512,
            tools: requests[0]?.tools,
        });
        expect(options).toEqual(originalOptions);
    });

    test.each([
        '{"path":',
        "not-json",
        "",
        "42",
        "-7",
        "1.5",
        "true",
        "false",
        "null",
        "[]",
        '"text"',
    ])("rejects invalid final tool input with its call id: %s", async (partialJson) => {
        const provider = defineStreamProvider(toolEvents(partialJson));
        await expect(collect(provider)).rejects.toThrow("INVALID_TOOL_INPUT");
        await expect(collect(provider)).rejects.toThrow("call-invalid");
    });

    test.each([{}, { path: "a.ts", enabled: true, count: 42 }])(
        "preserves start input when no JSON deltas arrive: %j",
        async (input) => {
            const snapshots = await collect(defineStreamProvider(toolEvents(undefined, input)));
            expect(snapshots.at(-1)?.content).toEqual([
                { type: "tool_use", id: "call-invalid", name: "read_file", input },
            ]);
        },
    );

    test("delta JSON replaces the start placeholder", async () => {
        const snapshots = await collect(
            defineStreamProvider(toolEvents('{"path":"final.ts"}', { path: "initial.ts" })),
        );
        expect(snapshots.at(-1)?.content).toEqual([
            {
                type: "tool_use",
                id: "call-invalid",
                name: "read_file",
                input: { path: "final.ts" },
            },
        ]);
    });

    test("isolates interleaved tool inputs and consumer mutations across snapshots and requests", async () => {
        const events = [
            messageStart(),
            {
                type: "content_block_start",
                index: 10,
                content_block: { type: "tool_use", id: "b", name: "tool", input: {} },
            },
            {
                type: "content_block_start",
                index: 2,
                content_block: { type: "tool_use", id: "a", name: "tool", input: {} },
            },
            {
                type: "content_block_delta",
                index: 2,
                delta: { type: "input_json_delta", partial_json: '{"nested":' },
            },
            {
                type: "content_block_delta",
                index: 10,
                delta: { type: "input_json_delta", partial_json: '{"b":true}' },
            },
            {
                type: "content_block_delta",
                index: 2,
                delta: { type: "input_json_delta", partial_json: '{"value":1}}' },
            },
            { type: "content_block_stop", index: 2 },
            { type: "content_block_stop", index: 10 },
            ...messageEnd(),
        ];
        const provider = defineStreamProvider(events);
        const originals: AssistantMessage[] = [];
        const snapshots: AssistantMessage[] = [];
        for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
            originals.push(structuredClone(snapshot));
            snapshots.push(snapshot);
        }
        expect(snapshots).toEqual(originals);
        const final = snapshots.at(-1)!;
        expect(final.content).toEqual([
            { type: "tool_use", id: "a", name: "tool", input: { nested: { value: 1 } } },
            { type: "tool_use", id: "b", name: "tool", input: { b: true } },
        ]);
        const [first, second] = await Promise.all([collect(provider), collect(provider)]);
        expect(first.at(-1)).toEqual(final);
        expect(second.at(-1)).toEqual(final);

        let mutated = false;
        const iterator = provider.stream({ model: "test-model", messages: [] });
        const observed: AssistantMessage[] = [];
        for await (const snapshot of iterator) {
            const toolContent = snapshot.content.find(
                (assistantContent) =>
                    assistantContent.type === "tool_use" && assistantContent.id === "a",
            );
            if (!mutated && toolContent?.type === "tool_use" && toolContent.input.nested) {
                (toolContent.input.nested as { value: number }).value = 99;
                mutated = true;
            }
            observed.push(snapshot);
        }
        expect(mutated).toBe(true);
        expect(observed.at(-1)).toEqual(final);
    });

    test("preserves empty text and signature-only thinking, and replaces cumulative usage", async () => {
        const snapshots = await collect(
            defineStreamProvider([
                messageStart(8, 1),
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "thinking", thinking: "", signature: "" },
                },
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "signature_delta", signature: "signed" },
                },
                { type: "content_block_stop", index: 0 },
                {
                    type: "content_block_start",
                    index: 1,
                    content_block: { type: "text", text: "" },
                },
                { type: "content_block_stop", index: 1 },
                { type: "message_delta", usage: { input_tokens: 9, output_tokens: 2 } },
                { type: "message_delta", usage: { input_tokens: null, output_tokens: 4 } },
                { type: "message_stop" },
            ]),
        );
        expect(snapshots[0]?.usage).toEqual({
            promptTokens: 8,
            completionTokens: 1,
            totalTokens: 9,
        });
        const thinkingContent: AnthropicThinkingContent = {
            type: "thinking",
            thinking: "",
            _anthropicSignature: "signed",
        };
        expect(snapshots.at(-1)).toEqual({
            role: "assistant",
            content: [thinkingContent, { type: "text", text: "" }],
            usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
        });
    });

    test("returns a final snapshot for an empty response with zero usage", async () => {
        const snapshots = await collect(
            defineStreamProvider([messageStart(0, 0), ...messageEnd(0)]),
        );
        expect(snapshots.at(-1)).toEqual({
            role: "assistant",
            content: [],
            usage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
            },
        });
    });

    test("rejects incomplete streams and unsigned final thinking", async () => {
        await expect(collect(defineStreamProvider([]))).rejects.toThrow("INCOMPLETE_STREAM");
        await expect(collect(defineStreamProvider([messageStart()]))).rejects.toThrow(
            "INCOMPLETE_STREAM",
        );
        await expect(
            collect(
                defineStreamProvider([
                    messageStart(),
                    {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "text", text: "partial" },
                    },
                    { type: "message_stop" },
                ]),
            ),
        ).rejects.toThrow("INCOMPLETE_STREAM");
        await expect(
            collect(
                defineStreamProvider([
                    messageStart(),
                    {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "thinking", thinking: "plan", signature: "" },
                    },
                    { type: "content_block_stop", index: 0 },
                    ...messageEnd(),
                ]),
            ),
        ).rejects.toThrow("MISSING_THINKING_SIGNATURE");
    });

    test("rejects unsupported content blocks instead of losing them", async () => {
        await expect(
            collect(
                defineStreamProvider([
                    messageStart(),
                    {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "redacted_thinking", data: "opaque" },
                    },
                ]),
            ),
        ).rejects.toThrow("UNSUPPORTED_CONTENT_BLOCK: redacted_thinking");
    });

    test("does not call the SDK for an already aborted request", async () => {
        let called = false;
        const client = {
            messages: {
                create: async () => {
                    called = true;
                },
            },
        };
        const provider = new AnthropicModelProvider({ client: client as unknown as Anthropic });
        const controller = new AbortController();
        const reason = new Error("cancelled");
        controller.abort(reason);
        await expect(
            provider.invoke({ model: "test-model", messages: [], signal: controller.signal }),
        ).rejects.toBe(reason);
        await expect(collect(provider, controller.signal)).rejects.toBe(reason);
        expect(called).toBe(false);
    });

    test("propagates cancellation when the SDK silently ends iteration", async () => {
        const controller = new AbortController();
        const reason = new Error("cancelled while streaming");
        let closed = false;
        const client = {
            messages: {
                create: async () =>
                    (async function* () {
                        try {
                            yield messageStart();
                            controller.abort(reason);
                        } finally {
                            closed = true;
                        }
                    })(),
            },
        };
        const provider = new AnthropicModelProvider({ client: client as unknown as Anthropic });
        await expect(collect(provider, controller.signal)).rejects.toBe(reason);
        expect(closed).toBe(true);
    });

    test("releases the stream when the consumer stops early", async () => {
        let closed = false;
        const client = {
            messages: {
                create: async () =>
                    (async function* () {
                        try {
                            yield messageStart();
                            yield* messageEnd();
                        } finally {
                            closed = true;
                        }
                    })(),
            },
        };
        const provider = new AnthropicModelProvider({ client: client as unknown as Anthropic });
        for await (const _ of provider.stream({ model: "test-model", messages: [] })) break;
        expect(closed).toBe(true);
    });

    test("propagates SDK request and stream errors", async () => {
        const failure = new Error("SDK failure");
        const client = {
            messages: {
                create: async () => {
                    throw failure;
                },
            },
        };
        const provider = new AnthropicModelProvider({ client: client as unknown as Anthropic });
        await expect(provider.invoke({ model: "test-model", messages: [] })).rejects.toBe(failure);
        await expect(collect(provider)).rejects.toBe(failure);

        const streamClient = {
            messages: {
                create: async () =>
                    (async function* () {
                        yield messageStart();
                        throw failure;
                    })(),
            },
        };
        await expect(
            collect(new AnthropicModelProvider({ client: streamClient as unknown as Anthropic })),
        ).rejects.toBe(failure);
    });
});

test("rejects reused block indexes and deltas after block completion", async () => {
    const prefix = [
        messageStart(),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "first" } },
        { type: "content_block_stop", index: 0 },
    ];
    await expect(
        collect(
            defineStreamProvider([
                ...prefix,
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "second" },
                },
            ]),
        ),
    ).rejects.toThrow("DUPLICATE_BLOCK_START");
    await expect(
        collect(
            defineStreamProvider([
                ...prefix,
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "late" },
                },
            ]),
        ),
    ).rejects.toThrow("MISSING_BLOCK_START");
});
test("streams signed thinking and replays it with tool results", async () => {
    let request: Record<string, unknown> | undefined;
    let sdkSignal: AbortSignal | undefined;
    const client = {
        messages: {
            create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
                request = body;
                sdkSignal = options.signal;
                if (!body.stream) {
                    return {
                        id: "message-2",
                        type: "message",
                        role: "assistant",
                        model: "test-model",
                        content: [{ type: "text", text: "done" }],
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        usage: { input_tokens: 5, output_tokens: 1 },
                    };
                }
                return (async function* () {
                    yield {
                        type: "message_start",
                        message: {
                            id: "message-1",
                            type: "message",
                            role: "assistant",
                            model: "test-model",
                            content: [],
                            stop_reason: null,
                            stop_sequence: null,
                            usage: { input_tokens: 3, output_tokens: 0 },
                        },
                    };
                    yield {
                        type: "content_block_start",
                        index: 0,
                        content_block: { type: "thinking", thinking: "", signature: "" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "thinking_delta", thinking: "plan" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "signature_delta", signature: "opaque-stream-signature" },
                    };
                    yield { type: "content_block_stop", index: 0 };
                    yield {
                        type: "content_block_start",
                        index: 1,
                        content_block: { type: "text", text: "" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 1,
                        delta: { type: "text_delta", text: "hel" },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 1,
                        delta: { type: "text_delta", text: "lo" },
                    };
                    yield { type: "content_block_stop", index: 1 };
                    yield {
                        type: "content_block_start",
                        index: 2,
                        content_block: {
                            type: "tool_use",
                            id: "call-1",
                            name: "read_file",
                            input: {},
                        },
                    };
                    yield {
                        type: "content_block_delta",
                        index: 2,
                        delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
                    };
                    yield { type: "content_block_stop", index: 2 };
                    yield {
                        type: "message_delta",
                        delta: { stop_reason: "tool_use", stop_sequence: null },
                        usage: { output_tokens: 2 },
                    };
                    yield { type: "message_stop" };
                })();
            },
        },
    };
    const controller = new AbortController();
    const provider = new AnthropicModelProvider({ client: client as never });
    const snapshots = [];
    const options = { thinking: { type: "enabled", budget_tokens: 1024 } };

    for await (const snapshot of provider.stream({
        model: "test-model",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        options,
        signal: controller.signal,
    })) {
        snapshots.push(snapshot);
    }

    expect(request).toMatchObject({ model: "test-model", stream: true, ...options });
    expect(sdkSignal).toBe(controller.signal);
    expect(
        snapshots.some((snapshot) =>
            snapshot.content.some((item) => item.type === "text" && item.text === "hel"),
        ),
    ).toBe(true);
    const final = snapshots.at(-1);
    if (!final) throw new Error("Expected a final snapshot");
    expect(final).toMatchObject({
        role: "assistant",
        content: [
            { type: "thinking", thinking: "plan", _anthropicSignature: "opaque-stream-signature" },
            { type: "text", text: "hello" },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });

    await provider.invoke({
        model: "test-model",
        messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            final,
            {
                role: "tool",
                content: [{ type: "tool_result", tool_use_id: "call-1", content: "file A" }],
            },
        ],
        options,
    });
    expect(request?.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "plan", signature: "opaque-stream-signature" },
                { type: "text", text: "hello" },
                { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
            ],
        },
        {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call-1", content: "file A" }],
        },
    ]);
});
