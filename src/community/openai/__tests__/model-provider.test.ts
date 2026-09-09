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