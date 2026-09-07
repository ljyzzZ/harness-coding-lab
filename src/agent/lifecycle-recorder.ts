import type { AgentMiddleware } from "./agent-middleware";

export function defineLifecycleRecorder(log: string[]): AgentMiddleware {
  // 返回的是 hook 实现集合；此时还没有运行 Agent，也不会向 log 写入内容。
  return {
    beforeAgentRun: async () => {
      // 等 host 开始一次 run 时才执行。闭包让 hook 能写入调用方传入的 log 数组。
      log.push("beforeAgentRun");
      // 没有 return，Promise 解析为 undefined：记录了日志，但不请求修改 AgentContext。
    },
    beforeAgentStep: async ({ step }) => {
      log.push(`beforeAgentStep:${step}`);
    },
    beforeModel: async () => {
      log.push("beforeModel");
    },
    afterModel: async () => {
      log.push("afterModel");
    },
    beforeToolUse: async ({ toolUse }) => {
      // toolUse 由 host 传入，因此同一个 hook 可以记录不同 Tool 的调用。
      log.push(`beforeToolUse:${toolUse.name}`);
    },
    afterToolUse: async ({ toolUse }) => {
      log.push(`afterToolUse:${toolUse.name}`);
    },
    afterAgentStep: async ({ step }) => {
      log.push(`afterAgentStep:${step}`);
    },
    afterAgentRun: async () => {
      log.push("afterAgentRun");
    },
  };
}