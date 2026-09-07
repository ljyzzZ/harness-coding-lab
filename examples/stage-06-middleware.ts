import { z } from "zod";

import { Agent } from "@/agent/agent";
import { defineLifecycleRecorder } from "@/agent/lifecycle-recorder";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

const responses: AssistantMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "weather-1",
        name: "get_weather",
        input: { description: "query fixture weather", city: "北京" },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "北京今天晴。" }],
  },
];
const weatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather",
  parameters: z.object({ description: z.string(), city: z.string() }),
  invoke: async ({ city }) => ({ city, condition: "晴" }),
});
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "北京天气如何？" }],
};
const log: string[] = [];
const agent = new Agent({
  model: new Model({
    name: "scripted",
    provider: new ScriptedModelProvider({ responses }),
  }),
  prompt: "Use get_weather when needed.",
  tools: [weatherTool],
  middlewares: [defineLifecycleRecorder(log)],
});

for await (const _event of agent.stream(userMessage)) {
  // 生命周期由 Middleware 记录，event stream 仍需完整消费。
}

console.log(log.join("\n"));