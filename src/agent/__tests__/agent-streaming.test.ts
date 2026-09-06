import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run tools" }],
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defineDelayTool(name: string, ms: number, onSignal?: (signal?: AbortSignal) => void) {
  return defineTool({
    name,
    description: `Wait ${ms}ms`,
    parameters: z.object({ description: z.string() }),
    invoke: async (_input, signal) => {
      onSignal?.(signal);
      await delay(ms, signal);
      return { name, ms };
    },
  });
}

function toolBatch(names: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: names.map((name) => ({
      type: "tool_use" as const,
      id: `call-${name}`,
      name,
      input: { description: `run ${name}` },
    })),
  };
}

async function drain(agent: Agent): Promise<void> {
  for await (const _event of agent.stream(USER)) {
    // consume
  }
}

describe("Agent streaming runtime", () => {
  test("appends tool results in completion order and runs them concurrently", async () => {
    const provider = new ScriptedModelProvider({
      responses: [
        toolBatch(["slow", "fast"]),
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [defineDelayTool("slow", 180), defineDelayTool("fast", 30)],
    });

    const startedAt = performance.now();
    await drain(agent);
    const elapsed = performance.now() - startedAt;
    const resultIds = agent.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content[0]?.tool_use_id);

    expect(resultIds).toEqual(["call-fast", "call-slow"]);
    expect(elapsed).toBeLessThan(280);
  });

  test("passes the same signal to tools and resets streaming after abort", async () => {
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => (started = resolve));
    const blockingTool = defineDelayTool("blocking", 10_000, (signal) => {
      receivedSignal = signal;
      started();
    });
    const provider = new ScriptedModelProvider({ responses: [toolBatch(["blocking"])] });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [blockingTool],
    });

    const run = drain(agent);
    await toolStarted;
    agent.abort();
    await expect(run).rejects.toBeDefined();

    expect(receivedSignal?.aborted).toBe(true);
    expect(agent.streaming).toBe(false);
  });

  test("does not cancel a sibling tool when one tool throws", async () => {
    let completed = false;
    const brokenTool = defineTool({
      name: "broken",
      description: "Throw",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        throw new Error("boom");
      },
    });
    const healthyTool = defineTool({
      name: "healthy",
      description: "Complete",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        await delay(20);
        completed = true;
        return "ok";
      },
    });
    const provider = new ScriptedModelProvider({
      responses: [
        toolBatch(["broken", "healthy"]),
        { role: "assistant", content: [{ type: "text", text: "observed" }] },
      ],
    });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [brokenTool, healthyTool],
    });

    await drain(agent);
    expect(completed).toBe(true);
    expect(agent.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  test("passes abort to the active model request", async () => {
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const provider: ModelProvider = {
      invoke: async () => ({ role: "assistant", content: [] }),
      stream: async function* (params: ModelProviderInvokeParams) {
        receivedSignal = params.signal;
        started();
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(params.signal?.reason), {
            once: true,
          });
        });
        yield { role: "assistant", content: [] };
      },
    };
    const agent = new Agent({
      model: new Model({ name: "blocking", provider }),
      prompt: "",
      tools: [],
    });

    const run = drain(agent);
    await modelStarted;
    agent.abort();
    await expect(run).rejects.toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("rejects a reentrant stream while a run is active", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const provider: ModelProvider = {
      invoke: async () => ({ role: "assistant", content: [] }),
      stream: async function* ({ signal }: ModelProviderInvokeParams) {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { role: "assistant", content: [] };
      },
    };
    const agent = new Agent({
      model: new Model({ name: "blocking", provider }),
      prompt: "",
      tools: [],
    });

    const firstRun = drain(agent);
    await modelStarted;
    await expect(drain(agent)).rejects.toThrow("already streaming");
    agent.abort();
    await expect(firstRun).rejects.toBeDefined();
  });
});