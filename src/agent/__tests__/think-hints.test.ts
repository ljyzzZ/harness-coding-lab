import { expect, test } from "bun:test";

import type { AssistantMessage, ToolUseContent, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models";
import type { ModelProvider } from "@/foundation/models";

import { Agent } from "../agent";
import type { AgentEvent } from "../agent-event";

const USER: UserMessage = { role: "user", content: [{ type: "text", text: "test" }] };
const THINKING_PROGRESS: AgentEvent = { type: "progress", subtype: "thinking" };
const TOOL_A: ToolUseContent = { type: "tool_use", id: "a", name: "tool_a", input: { x: 1 } };
const TOOL_B: ToolUseContent = { type: "tool_use", id: "b", name: "tool_b", input: { x: 2 } };

function defineTextMessage(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function defineAgent(snapshots: AssistantMessage[]): Agent {
  const provider: ModelProvider = {
    invoke: async () => { throw new Error("Expected streaming model invocation"); },
    stream: async function* ({ signal }) {
      for (const snapshot of snapshots) {
        signal?.throwIfAborted();
        yield snapshot;
      }
    },
  };
  return new Agent({ model: new Model({ name: "hints", provider }), prompt: "" });
}

test("text progress precedes one final message without entering the transcript", async () => {
  const final = defineTextMessage("你好");
  const agent = defineAgent([defineTextMessage("你"), final]);
  const events: AgentEvent[] = [];

  for await (const event of agent.stream(USER)) {
    if (event.type === "progress") expect(agent.messages).toEqual([USER]);
    events.push(event);
  }

  expect(events).toEqual([
    THINKING_PROGRESS,
    THINKING_PROGRESS,
    { type: "message", message: final },
  ]);
  expect(agent.messages).toEqual([USER, final]);
});

const cases: {
  name: string;
  content: AssistantMessage["content"];
  progress: AgentEvent;
}[] = [
  { name: "empty content", content: [], progress: THINKING_PROGRESS },
  {
    name: "text with thinking",
    content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "好" }],
    progress: THINKING_PROGRESS,
  },
  {
    name: "text with a tool",
    content: [{ type: "text", text: "查" }, TOOL_A],
    progress: { type: "progress", subtype: "tool", name: TOOL_A.name, input: TOOL_A.input },
  },
  {
    name: "the last of two tools",
    content: [TOOL_A, TOOL_B],
    progress: { type: "progress", subtype: "tool", name: TOOL_B.name, input: TOOL_B.input },
  },
];

for (const scenario of cases) {
  test(`classifies ${scenario.name}`, async () => {
    const snapshot: AssistantMessage = { role: "assistant", content: scenario.content };
    const agent = defineAgent([snapshot]);
    const iterator = agent.stream(USER);

    try {
      expect(await iterator.next()).toEqual({ done: false, value: scenario.progress });
      expect(agent.messages).toEqual([USER]);
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: "message", message: snapshot },
      });
      expect(agent.messages).toEqual([USER, snapshot]);
    } finally {
      // 在进入 _act() 前结束本次迭代，同时让 stream() 的 finally 清理运行状态。
      await iterator.return(undefined);
    }
  });
}

test("an empty model stream retains the error path", async () => {
  const agent = defineAgent([]);
  await expect(agent.stream(USER).next()).rejects.toThrow(
    "Model stream did not yield an assistant message",
  );
  expect(agent.messages).toEqual([USER]);
});