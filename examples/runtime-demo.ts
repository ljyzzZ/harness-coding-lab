import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage, ToolUseContent } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    parallel: { type: "boolean", default: false },
    deny: { type: "string" },
    "abort-after": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});
const abortAfter = values["abort-after"] === undefined
  ? undefined
  : Number(values["abort-after"]);
if (abortAfter !== undefined && (!Number.isSafeInteger(abortAfter) || abortAfter < 0)) {
  throw new Error("--abort-after 必须是非负整数毫秒数");
}
if (values.deny !== undefined && values.deny !== "get_weather") {
  throw new Error("此示例仅支持 --deny get_weather");
}
if ([values.parallel, values.deny !== undefined, abortAfter !== undefined].filter(Boolean).length > 1) {
  throw new Error("请分别运行三个选项，便于观察每一种场景");
}

let activeTools = 0;
let invokedTools = 0;
let afterRunCount = 0;
let observedByModel = 0;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
const completed: string[] = [];
const observations: string[] = [];

function defineDemoTool(name: string, milliseconds: number, result: string) {
  return defineTool({
    name,
    description: "Return a fixed offline result",
    parameters: z.object({ description: z.string() }),
    invoke: async (_input, signal) => {
      invokedTools += 1;
      activeTools += 1;
      console.log(`[tool:start] ${name}`);
      try {
        // 将 run signal 传给真正的异步操作，取消时不必等计时结束。
        await delay(milliseconds, undefined, { signal });
        completed.push(name);
        console.log(`[tool:done] ${name}`);
        return result;
      } finally {
        activeTools -= 1;
        console.log(`[tool:cleanup] ${name}`);
      }
    },
  });
}

const names = values.parallel ? ["get_weather", "get_time"] : ["get_weather"];
const calls: ToolUseContent[] = names.map((name) => ({
  type: "tool_use", id: `call-${name}`, name, input: { description: "演示离线工具调用" },
}));
const responses: AssistantMessage[] = [
  { role: "assistant", content: calls },
  {
    role: "assistant",
    content: [{ type: "text", text: values.deny ? "天气查询被拒绝。" : "离线工具调用完成。" }],
  },
];
const agent = new Agent({
  prompt: "Run the offline demo",
  model: new Model({ name: "scripted", provider: new ScriptedModelProvider({ responses }) }),
  tools: [
    defineDemoTool("get_weather", 300, "晴，26°C"),
    defineDemoTool("get_time", 30, "12:00"),
  ],
  middlewares: [{
    beforeAgentRun: async () => {
      if (abortAfter !== undefined) {
        abortTimer = setTimeout(() => {
          console.log("[run:abort-requested]");
          agent.abort();
        }, abortAfter);
      }
    },
    beforeModel: async ({ modelContext }) => {
      // 第二次模型调用必须能读到 observation，包括被拒绝的 Tool。
      observedByModel = modelContext.messages.filter((message) => message.role === "tool").length;
      console.log(`[model:observations] ${observedByModel}`);
    },
    beforeToolUse: async ({ toolUse }) => {
      if (toolUse.name === values.deny) {
        console.log(`[tool:denied] ${toolUse.name}`);
        return { __skip: true, result: { error: "Denied by demo middleware" } };
      }
    },
    afterAgentRun: async () => {
      afterRunCount += 1;
      console.log("[run:cleanup]");
    },
  }],
});

let aborted = false;
try {
  for await (const event of agent.stream({ role: "user", content: [{ type: "text", text: "运行演示" }] })) {
    if (event.type !== "message") continue;
    if (event.message.role === "tool") {
      for (const result of event.message.content) {
        observations.push(result.tool_use_id);
        console.log(`[observation] ${result.tool_use_id}: ${result.content}`);
      }
    } else {
      console.log(`[assistant] ${JSON.stringify(event.message.content)}`);
    }
  }
} catch (error) {
  // 只吞掉预期取消；实现错误继续抛出，让命令失败。
  if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  aborted = true;
  console.log("[run:aborted]");
} finally {
  clearTimeout(abortTimer);
  console.log(`[summary] activeTools=${activeTools}, afterRun=${afterRunCount}, streaming=${agent.streaming}`);
}

assert.equal(activeTools, 0);
assert.equal(afterRunCount, 1);
assert.equal(agent.streaming, false);
if (!aborted) {
  assert.equal(observedByModel, names.length);
  assert.equal(observations.length, names.length);
  assert.equal(invokedTools, values.deny ? 0 : names.length);
  if (values.parallel) {
    assert.deepEqual(completed, ["get_time", "get_weather"]);
    assert.deepEqual(observations, ["call-get_time", "call-get_weather"]);
  }
}
// ANSI 32m 设置绿色，0m 重置颜色，避免影响后续终端输出。
console.log("\u001b[32m[check] passed\u001b[0m");