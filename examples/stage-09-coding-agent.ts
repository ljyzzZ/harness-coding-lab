import { join, resolve } from "node:path";

import { TodoSystem } from "@/agent/todos/todo-system";
import { defineCodingAgent } from "@/coding/agents/coding-agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

class RecordingScriptedProvider implements ModelProvider {
    readonly requests: ModelProviderInvokeParams[] = [];
    private readonly _provider: ScriptedModelProvider;

    constructor(options: { responses: AssistantMessage[] }) {
        this._provider = new ScriptedModelProvider(options);
    }

    async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
        this.requests.push(params);
        return this._provider.invoke(params);
    }

    async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
        this.requests.push(params);
        yield* this._provider.stream(params);
    }
}

const responses: AssistantMessage[] = [
    {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "skill-1",
                name: "read_file",
                input: {
                    description: "load the selected test-writer Skill",
                    path: ".agents/skills/test-writer/SKILL.md",
                },
            },
        ],
    },
    {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "todo-1",
                name: "todo_write",
                input: {
                    description: "track fixture inspection",
                    merge: false,
                    items: [{ id: "inspect", text: "Inspect src/math.ts", status: "in_progress" }],
                },
            },
        ],
    },
    {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "read-1",
                name: "read_file",
                input: { description: "inspect the fixture source", path: "src/math.ts" },
            },
        ],
    },
    {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "ask-1",
                name: "ask_user_question",
                input: {
                    description: "confirm the next task",
                    question: "Should we add a test next?",
                },
            },
        ],
    },
    {
        role: "assistant",
        content: [
            {
                type: "tool_use",
                id: "todo-2",
                name: "todo_write",
                input: {
                    description: "finish fixture inspection",
                    merge: true,
                    items: [{ id: "inspect", text: "Inspect src/math.ts", status: "completed" }],
                },
            },
        ],
    },
    {
        role: "assistant",
        content: [
            { type: "text", text: "Loaded guidance and Skill, inspected source, and recorded the user's answer." },
        ],
    },
];

async function main(): Promise<void> {
    const fixtureArgument = Bun.argv[2];
    if (!fixtureArgument) {
        console.log("Usage: bun run examples/stage-09-coding-agent.ts <fixture-workspace>");
        return;
    }

    const cwd = resolve(fixtureArgument);
    const requiredFiles = ["AGENTS.md", ".agents/skills/test-writer/SKILL.md", "src/math.ts"];
    for (const path of requiredFiles) {
        if (!(await Bun.file(join(cwd, path)).exists())) {
            throw new Error(`Missing fixture file: ${join(cwd, path)}`);
        }
    }

    const provider = new RecordingScriptedProvider({ responses });
    const todos = new TodoSystem({ reminderAfterSteps: 3 });
    const agent = await defineCodingAgent({
        model: new Model({ name: "scripted", provider }),
        cwd,
        todos,
        skillsDirs: [join(cwd, ".agents", "skills")],
        askUserQuestion: async ({ question }) => ({ answer: `fixture answer: ${question}` }),
    });
    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: "Inspect the fixture using the test-writing guidance." }],
    };

    for await (const event of agent.stream(userMessage)) {
        if (event.type === "message") console.log(JSON.stringify(event.message));
    }

    const guidance = (await Bun.file(join(cwd, "AGENTS.md")).text()).trim();
    const firstModelView = (provider.requests[0]?.messages ?? [])
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.map((item) => (item.type === "text" ? item.text : "")))
        .join("\n");
    if (!firstModelView.includes("test-writer") || !firstModelView.includes(guidance)) {
        throw new Error("Project guidance or Skill metadata was not included in the first model view");
    }

    const observations = agent.messages.flatMap((message) => (message.role === "tool" ? message.content : []));
    for (const id of ["skill-1", "todo-1", "read-1", "todo-2"]) {
        const observation = observations.find((item) => item.tool_use_id === id);
        if (!observation || JSON.parse(observation.content).ok !== true) {
            throw new Error(`Expected successful Tool result for ${id}`);
        }
    }
    const answer = observations.find((item) => item.tool_use_id === "ask-1");
    if (!answer || JSON.parse(answer.content).answer !== "fixture answer: Should we add a test next?") {
        throw new Error("The answer was not returned to ask-1");
    }
    const snapshot = todos.snapshot();
    if (snapshot.length !== 1 || snapshot[0]?.id !== "inspect" || snapshot[0].status !== "completed") {
        throw new Error("The shared Todo store was not updated to completed");
    }
    console.log("Final Todos:", snapshot);
    console.log(JSON.stringify(agent.messages, null, 2));
    console.log("[offline] completed with ScriptedModelProvider; no API request was made");
}

await main();
