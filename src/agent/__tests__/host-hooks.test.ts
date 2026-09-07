import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider } from "@/foundation/models/model-provider";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";
import type { AgentMiddleware } from "../agent-middleware";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run" }],
};
const TOOL_CALL: AssistantMessage = {
  role: "assistant",
  content: [{
    type: "tool_use",
    id: "work-1",
    name: "work",
    input: { description: "verify the second model step" },
  }],
};
const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};

function defineHostTestAgent(options: {
  responses: AssistantMessage[];
  middlewares: AgentMiddleware[];
  invoke?: () => Promise<unknown>;
}): Agent {
  let cursor = 0;
  const provider: ModelProvider = {
    async invoke({ signal }) {
      signal?.throwIfAborted();
      const response = options.responses[cursor++];
      if (!response) throw new Error("No fixture response left");
      // 每次交付独立对象，防止 Middleware 修改共享 fixture，污染其他测试。
      return structuredClone(response);
    },
    async *stream(params) {
      yield await this.invoke(params);
    },
  };
  const tool = defineTool({
    name: "work",
    description: "Return a fixture result",
    parameters: z.object({ description: z.string() }),
    invoke: options.invoke ?? (async () => "ok"),
  });
  return new Agent({
    model: new Model({ name: "host-test", provider }),
    prompt: "test",
    tools: [tool],
    middlewares: options.middlewares,
    maxSteps: 3,
  });
}

describe("Agent host hooks", () => {
  test("calls beforeAgentRun once across two model steps", async () => {
    const calls: string[] = [];
    let toolCalls = 0;
    const agent = defineHostTestAgent({
      responses: [TOOL_CALL, FINAL],
      middlewares: [{
        beforeAgentRun: async () => { calls.push("beforeAgentRun"); },
        beforeModel: async () => { calls.push("beforeModel"); },
      }],
      invoke: async () => {
        toolCalls += 1;
        return "ok";
      },
    });

    for await (const _event of agent.stream(structuredClone(USER))) {
      // 必须消费到结束，第二轮模型请求才会发生。
    }

    expect(calls).toEqual(["beforeAgentRun", "beforeModel", "beforeModel"]);
    expect(toolCalls).toBe(1);
    expect(agent.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "tool", "assistant",
    ]);
  });

  test("merges afterModel updates before the next hook and message event", async () => {
    const expectedContent: AssistantMessage["content"] = [
      { type: "text", text: "reviewed: done" },
    ];
    const seenByNextHook: AssistantMessage["content"][] = [];
    const emittedMessages: AssistantMessage[] = [];
    const agent = defineHostTestAgent({
      responses: [FINAL],
      middlewares: [
        {
          afterModel: async () => {
            await Promise.resolve();
            // 只返回更新字段，不直接修改 message，确保测试真正检查 host 的合并。
            return { content: structuredClone(expectedContent) };
          },
        },
        {
          afterModel: async ({ message }) => {
            // 立即复制，固定“第二个 hook 执行时”看到的内容。
            seenByNextHook.push(structuredClone(message.content));
          },
        },
      ],
    });

    for await (const event of agent.stream(structuredClone(USER))) {
      if (event.type === "message" && event.message.role === "assistant") {
        // 同样记录收到事件时的快照，不能等 run 结束后才读取共享对象。
        emittedMessages.push(structuredClone(event.message));
      }
    }

    expect(seenByNextHook).toEqual([expectedContent]);
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0]?.content).toEqual(expectedContent);
    expect(agent.messages).toEqual([
      USER,
      { role: "assistant", content: expectedContent },
    ]);
  });
});