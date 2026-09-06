import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

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

const delayTool = defineTool({
  name: "delay",
  description: "Wait for a bounded duration",
  parameters: z.object({
    description: z.string(),
    ms: z.number().finite().int().nonnegative(),
    label: z.string().min(1),
  }),
  invoke: async ({ ms, label }, signal) => {
    await wait(ms, signal);
    return { label, ms };
  },
});
const toolCall: AssistantMessage = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "delay-1",
      name: "delay",
      input: { description: "demonstrate abort", ms: 10_000, label: "slow" },
    },
  ],
};
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "start a long delay" }],
};
const agent = new Agent({
  model: new Model({
    name: "scripted",
    provider: new ScriptedModelProvider({ responses: [toolCall] }),
  }),
  prompt: "Run the requested delay.",
  tools: [delayTool],
});
const startedAt = performance.now();
const abortTimer = setTimeout(() => {
  console.log("[abort] request user cancellation");
  agent.abort();
}, 100);

try {
  for await (const _event of agent.stream(userMessage)) {
    // consume
  }
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.log(`[stopped] ${message}`);
} finally {
  clearTimeout(abortTimer);
}

console.log(
  `[done] elapsed=${Math.round(performance.now() - startedAt)}ms streaming=${agent.streaming}`,
);