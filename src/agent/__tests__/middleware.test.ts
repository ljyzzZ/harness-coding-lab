import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
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
  invoke?: () => Promise<unknown>;
  responses?: AssistantMessage[];
  maxSteps?: number;
}): Agent {
  const tool = defineTool({
    name: "work",
    description: "Test work",
    parameters: z.object({ description: z.string() }),
    invoke: options.invoke ?? (async () => "ok"),
  });
  return new Agent({
    model: new Model({
      name: "scripted",
      provider: new ScriptedModelProvider({ responses: options.responses ?? [TOOL_CALL, FINAL] }),
    }),
    prompt: "test",
    tools: [tool],
    middlewares: options.middlewares,
    maxSteps: options.maxSteps,
  });
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
});