import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run slow and fast" }],
};

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const startedAt = performance.now();

function log(event: "tool_start" | "tool_end", name: string): void {
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`${elapsed}ms  ${event} ${name}`);
}

function defineDelayTool(name: string, ms: number) {
  return defineTool({
    name,
    description: `Wait ${ms}ms`,
    parameters: z.object({ description: z.string() }),
    invoke: async (_input, signal) => {
      log("tool_start", name);
      await wait(ms, signal);
      log("tool_end", name);
      return { name, ms };
    },
  });
}

const toolCalls: AssistantMessage = {
  role: "assistant",
  content: ["slow", "fast"].map((name) => ({
    type: "tool_use" as const,
    id: `call-${name}`,
    name,
    input: { description: `run ${name}` },
  })),
};
const provider = new ScriptedModelProvider({
  responses: [
    toolCalls,
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ],
});
const agent = new Agent({
  model: new Model({ name: "scripted", provider }),
  prompt: "Run independent tools together.",
  tools: [defineDelayTool("slow", 300), defineDelayTool("fast", 30)],
});

for await (const _event of agent.stream(userMessage)) {
  // Tool 自身记录开始和结束时间；这里只消费完整 event stream。
}