import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import type { ModelProvider } from "@/foundation/models/model-provider";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";
import type { AgentMiddleware } from "../agent-middleware";
import { defineLifecycleRecorder } from "../lifecycle-recorder";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run" }],
};
const TOOL_CALL: AssistantMessage = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "call-1",
      name: "work",
      input: { description: "do work" },
    },
  ],
};
const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};

async function drain(agent: Agent): Promise<void> {
  for await (const _event of agent.stream(USER)) {
    // consume
  }
}

function defineAgent(options: {
  middlewares: AgentMiddleware[];
  invoke?: (signal?: AbortSignal) => Promise<unknown>;
  responses?: AssistantMessage[];
  provider?: ModelProvider;
  maxSteps?: number;
}): Agent {
  const tool = defineTool({
    name: "work",
    description: "Test work",
    parameters: z.object({ description: z.string() }),
    invoke: async (_input, signal) => options.invoke ? options.invoke(signal) : "ok",
  });
  return new Agent({
    model: new Model({
      name: "scripted",
      provider: options.provider ?? new ScriptedModelProvider({ responses: options.responses ?? [TOOL_CALL, FINAL] }),
    }),
    prompt: "test",
    tools: [tool],
    middlewares: options.middlewares,
    maxSteps: options.maxSteps,
  });
}

// 手动控制“hook 已进入”和“允许 hook 返回”，不依赖计时。
function defineHookGate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

// 故意不处理 signal，确保测试能发现 host 取消后仍调用 provider 的错误。
function defineProbeProvider(responses: AssistantMessage[]) {
  let calls = 0;
  const provider: ModelProvider = {
    async invoke() {
      const response = responses[calls++];
      if (!response) throw new Error("No probe response left");
      return structuredClone(response);
    },
    async *stream(params) {
      yield await this.invoke(params);
    },
  };
  return { provider, callCount: () => calls };
}

async function abortWhileHookWaits(
  agent: Agent,
  gate: Pick<ReturnType<typeof defineHookGate>, "entered" | "release">,
): Promise<AssistantMessage[]> {
  const emitted: AssistantMessage[] = [];
  // 立刻接上 rejection handler，避免取消时出现未处理的 Promise rejection。
  const outcome = (async () => {
    for await (const event of agent.stream(structuredClone(USER))) {
      if (event.type === "message" && event.message.role === "assistant") {
        emitted.push(structuredClone(event.message));
      }
    }
  })().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  try {
    await Promise.race([
      gate.entered,
      outcome.then(() => { throw new Error("Run ended before reaching the hook"); }),
    ]);
    agent.abort();
  } finally {
    // 即使断言或前置操作失败，也不要让测试创建的等待永久悬挂。
    gate.release();
    await outcome;
  }

  expect(await outcome).toMatchObject({ ok: false, error: { name: "AbortError" } });
  expect(agent.streaming).toBe(false);
  return emitted;
}

describe("Agent middleware", () => {
  test("runs the complete lifecycle in the documented order", async () => {
    const log: string[] = [];
    await drain(defineAgent({ middlewares: [defineLifecycleRecorder(log)] }));

    expect(log).toEqual([
      "beforeAgentRun",
      "beforeAgentStep:1",
      "beforeModel",
      "afterModel",
      "beforeToolUse:work",
      "afterToolUse:work",
      "afterAgentStep:1",
      "beforeAgentStep:2",
      "beforeModel",
      "afterModel",
      "afterAgentRun",
    ]);
  });

  test("runs multiple middleware in array order", async () => {
    const log: string[] = [];
    const defineOrderMiddleware = (name: string): AgentMiddleware => ({
      beforeModel: async () => {
        log.push(name);
      },
    });
    await drain(
      defineAgent({
        middlewares: [defineOrderMiddleware("first"), defineOrderMiddleware("second")],
      }),
    );

    expect(log.slice(0, 2)).toEqual(["first", "second"]);
  });

  test("keeps beforeModel messages out of the canonical transcript", async () => {
    const temporaryView: AgentMiddleware = {
      beforeModel: async ({ modelContext }) => ({
        messages: [
          ...modelContext.messages,
          { role: "user", content: [{ type: "text", text: "temporary reminder" }] },
        ],
      }),
    };
    const agent = defineAgent({ middlewares: [temporaryView] });

    await drain(agent);
    expect(JSON.stringify(agent.messages)).not.toContain("temporary reminder");
  });

  test("turns a skipped tool into an observation without invoking it", async () => {
    let invokeCount = 0;
    const deny: AgentMiddleware = {
      beforeToolUse: async () => ({
        __skip: true,
        result: { ok: false, code: "DENIED", error: "Denied by test" },
      }),
    };
    const agent = defineAgent({
      middlewares: [deny],
      invoke: async () => {
        invokeCount += 1;
        return "unexpected";
      },
    });

    await drain(agent);
    const toolMessage = agent.messages.find((message) => message.role === "tool");
    expect(invokeCount).toBe(0);
    expect(toolMessage?.content[0]?.content).toContain("DENIED");
  });

  test("calls afterToolUse with a normalized tool failure", async () => {
    let afterToolUseCount = 0;
    const observe: AgentMiddleware = {
      afterToolUse: async ({ toolResult }) => {
        expect(toolResult).toMatchObject({ ok: false });
        afterToolUseCount += 1;
      },
    };
    const agent = defineAgent({
      middlewares: [observe],
      invoke: async () => {
        throw new Error("boom");
      },
    });

    await drain(agent);
    expect(afterToolUseCount).toBe(1);
  });

  test("calls afterAgentRun once when maxSteps fails", async () => {
    let afterRunCount = 0;
    const agent = defineAgent({
      middlewares: [
        {
          afterAgentRun: async () => {
            afterRunCount += 1;
          },
        },
      ],
      responses: [TOOL_CALL],
      maxSteps: 1,
    });

    await expect(drain(agent)).rejects.toBeDefined();
    expect(afterRunCount).toBe(1);
  });
  // 5 个用例：逐个验证正常推进任务的 hook 的等待边界。
  for (const [hook, expectedModelCalls, expectedMessages] of [
    ["beforeAgentRun", 0, 0],
    ["beforeAgentStep", 0, 0],
    ["beforeModel", 0, 0],
    ["afterModel", 1, 0],
    ["beforeToolUse", 1, 1],
  ] as const) {
    test(`stops work when aborted during ${hook}`, async () => {
      const gate = defineHookGate();
      const probe = defineProbeProvider([TOOL_CALL, FINAL]);
      let toolCalls = 0;
      let afterRunCount = 0;
      const middleware: AgentMiddleware = {
        afterAgentRun: async () => { afterRunCount += 1; },
      };
      middleware[hook] = gate.wait;
      const agent = defineAgent({
        provider: probe.provider,
        middlewares: [middleware],
        invoke: async () => { toolCalls += 1; return "ok"; },
      });

      const emitted = await abortWhileHookWaits(agent, gate);
      expect(probe.callCount()).toBe(expectedModelCalls);
      expect(toolCalls).toBe(0);
      expect(afterRunCount).toBe(1);
      expect(emitted).toHaveLength(expectedMessages);
      expect(agent.messages.filter((message) => message.role === "assistant"))
        .toHaveLength(expectedMessages);
    });
  }

  test("does not enter afterModel if the model finishes after cancellation", async () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let afterModelCount = 0;
    let afterRunCount = 0;
    const provider: ModelProvider = {
      async invoke() {
        entered.resolve();
        await released.promise;
        // 模拟不响应 signal、取消后仍返回结果的 provider。
        return structuredClone(FINAL);
      },
      async *stream(params) { yield await this.invoke(params); },
    };
    const agent = defineAgent({
      provider,
      middlewares: [{
        afterModel: async () => { afterModelCount += 1; },
        afterAgentRun: async () => { afterRunCount += 1; },
      }],
    });

    const emitted = await abortWhileHookWaits(agent, {
      entered: entered.promise,
      release: () => released.resolve(),
    });
    expect(afterModelCount).toBe(0);
    expect(afterRunCount).toBe(1);
    expect(emitted).toEqual([]);
    expect(agent.messages).toEqual([USER]);
  });

  test("does not execute tools after cancellation at a message yield", async () => {
    const probe = defineProbeProvider([TOOL_CALL, FINAL]);
    let toolCalls = 0;
    let afterRunCount = 0;
    let assistantEvents = 0;
    const agent = defineAgent({
      provider: probe.provider,
      middlewares: [{ afterAgentRun: async () => { afterRunCount += 1; } }],
      invoke: async () => { toolCalls += 1; return "ok"; },
    });
    const run = (async () => {
      for await (const event of agent.stream(structuredClone(USER))) {
        if (event.type === "message" && event.message.role === "assistant") {
          assistantEvents += 1;
          // 此刻生成器停在 yield，下一轮 next() 才会恢复执行。
          agent.abort();
        }
      }
    })();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(assistantEvents).toBe(1);
    expect(toolCalls).toBe(0);
    expect(probe.callCount()).toBe(1);
    expect(afterRunCount).toBe(1);
    expect(agent.streaming).toBe(false);
  });

  // 2 个用例：收尾保留已经发生的事实，但不能因此开启下一轮工作。
  for (const hook of ["afterToolUse", "afterAgentStep"] as const) {
    test(`keeps the completed tool observation when aborted during ${hook}`, async () => {
      const gate = defineHookGate();
      const probe = defineProbeProvider([TOOL_CALL, FINAL]);
      let toolCalls = 0;
      let afterRunCount = 0;
      const middleware: AgentMiddleware = {
        afterAgentRun: async () => { afterRunCount += 1; },
      };
      middleware[hook] = gate.wait;
      const agent = defineAgent({
        provider: probe.provider,
        middlewares: [middleware],
        invoke: async () => { toolCalls += 1; return "completed-work"; },
      });

      const emitted = await abortWhileHookWaits(agent, gate);
      expect(toolCalls).toBe(1);
      expect(probe.callCount()).toBe(1);
      expect(afterRunCount).toBe(1);
      expect(emitted).toHaveLength(1);
      expect(agent.messages.map((message) => message.role)).toEqual([
        "user", "assistant", "tool",
      ]);
      const observation = agent.messages.find((message) => message.role === "tool");
      expect(observation?.content[0]?.tool_use_id).toBe("call-1");
      expect(observation?.content[0]?.content).toContain("completed-work");
    });
  }

  test("runs cleanup and resets state if beforeAgentRun throws", async () => {
    const failure = new Error("before run failed");
    const probe = defineProbeProvider([FINAL]);
    let afterRunCount = 0;
    const agent = defineAgent({
      provider: probe.provider,
      middlewares: [{
        beforeAgentRun: async () => { throw failure; },
        afterAgentRun: async () => { afterRunCount += 1; },
      }],
    });

    await expect(drain(agent)).rejects.toBe(failure);
    expect(probe.callCount()).toBe(0);
    expect(afterRunCount).toBe(1);
    expect(agent.streaming).toBe(false);
  });

  test("runs cleanup and resets state if the model throws", async () => {
    const failure = new Error("model failed");
    let afterRunCount = 0;
    const provider: ModelProvider = {
      async invoke() { throw failure; },
      async *stream(params) { yield await this.invoke(params); },
    };
    const agent = defineAgent({
      provider,
      middlewares: [{ afterAgentRun: async () => { afterRunCount += 1; } }],
    });

    await expect(drain(agent)).rejects.toBe(failure);
    expect(afterRunCount).toBe(1);
    expect(agent.streaming).toBe(false);
  });

  test("resets state even if afterAgentRun itself throws", async () => {
    const failure = new Error("cleanup failed");
    let afterRunCount = 0;
    const agent = defineAgent({
      responses: [FINAL],
      middlewares: [{
        afterAgentRun: async () => { afterRunCount += 1; throw failure; },
      }],
    });

    await expect(drain(agent)).rejects.toBe(failure);
    expect(afterRunCount).toBe(1);
    expect(agent.streaming).toBe(false);
  });

  test("stops pulling snapshots after cancellation at a progress yield", async () => {
    let snapshots = 0;
    let progressEvents = 0;
    let afterModelCount = 0;
    let afterRunCount = 0;
    const provider: ModelProvider = {
      async invoke() { return structuredClone(FINAL); },
      async *stream() {
        // 故意不检查 signal，验证 runtime 在 yield 恢复后的检查点。
        for (const text of ["d", "do", "done"]) {
          snapshots += 1;
          yield { role: "assistant", content: [{ type: "text", text }] } as AssistantMessage;
        }
      },
    };
    const agent = defineAgent({
      provider,
      middlewares: [{
        afterModel: async () => { afterModelCount += 1; },
        afterAgentRun: async () => { afterRunCount += 1; },
      }],
    });
    const run = (async () => {
      for await (const event of agent.stream(structuredClone(USER))) {
        if (event.type === "progress") { progressEvents += 1; agent.abort(); }
      }
    })();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(snapshots).toBe(1);
    expect(progressEvents).toBe(1);
    expect(afterModelCount).toBe(0);
    expect(afterRunCount).toBe(1);
    expect(agent.messages).toEqual([USER]);
    expect(agent.streaming).toBe(false);
  });

  test("does not publish a snapshot delivered after cancellation", async () => {
    const gate = defineHookGate();
    let progressEvents = 0;
    let afterModelCount = 0;
    let afterRunCount = 0;
    const provider: ModelProvider = {
      async invoke() { await gate.wait(); return structuredClone(FINAL); },
      async *stream(params) { yield await this.invoke(params); },
    };
    const agent = defineAgent({
      provider,
      middlewares: [{
        afterModel: async () => { afterModelCount += 1; },
        afterAgentRun: async () => { afterRunCount += 1; },
      }],
    });
    const outcome = (async () => {
      for await (const event of agent.stream(structuredClone(USER))) {
        if (event.type === "progress") progressEvents += 1;
      }
    })().then(() => null, (error: unknown) => error);
    try {
      await Promise.race([
        gate.entered,
        outcome.then(() => { throw new Error("Run ended before the provider started"); }),
      ]);
      agent.abort();
    } finally {
      gate.release();
      await outcome;
    }

    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(progressEvents).toBe(0);
    expect(afterModelCount).toBe(0);
    expect(afterRunCount).toBe(1);
    expect(agent.messages).toEqual([USER]);
    expect(agent.streaming).toBe(false);
  });

  test("records a successful tool result even if cancellation precedes afterToolUse", async () => {
    const probe = defineProbeProvider([TOOL_CALL, FINAL]);
    let toolCalls = 0;
    const hookResults: unknown[] = [];
    let afterRunCount = 0;
    const agent = defineAgent({
      provider: probe.provider,
      middlewares: [{
        afterToolUse: async ({ toolResult }) => { hookResults.push(toolResult); },
        afterAgentRun: async () => { afterRunCount += 1; },
      }],
      invoke: async () => {
        toolCalls += 1;
        // 模拟副作用已完成，取消请求恰好发生在返回成功结果之前。
        agent.abort();
        return "completed-before-cancel";
      },
    });

    await expect(drain(agent)).rejects.toMatchObject({ name: "AbortError" });
    expect(toolCalls).toBe(1);
    expect(probe.callCount()).toBe(1);
    expect(hookResults).toEqual(["completed-before-cancel"]);
    expect(afterRunCount).toBe(1);
    expect(agent.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    const observation = agent.messages.find((message) => message.role === "tool");
    expect(observation?.content[0]?.tool_use_id).toBe("call-1");
    expect(observation?.content[0]?.content).toContain("completed-before-cancel");
    expect(agent.streaming).toBe(false);
  });

  test("propagates an actually aborted tool instead of recording an ordinary failure", async () => {
    const gate = defineHookGate();
    const probe = defineProbeProvider([TOOL_CALL, FINAL]);
    let afterToolUseCount = 0;
    let afterRunCount = 0;
    const agent = defineAgent({
      provider: probe.provider,
      middlewares: [{
        afterToolUse: async () => { afterToolUseCount += 1; },
        afterAgentRun: async () => { afterRunCount += 1; },
      }],
      invoke: async (signal) => {
        if (!signal) throw new Error("Tool did not receive the run signal");
        await gate.wait();
        // 与上一例不同：执行确实因取消而失败，没有成功结果可发布。
        signal.throwIfAborted();
        return "unexpected";
      },
    });

    await abortWhileHookWaits(agent, gate);
    expect(probe.callCount()).toBe(1);
    expect(afterToolUseCount).toBe(0);
    expect(afterRunCount).toBe(1);
    expect(agent.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // 阶段 12 会为结果未知的动作保存 execution record；本阶段不伪造成功 observation。
  });

});