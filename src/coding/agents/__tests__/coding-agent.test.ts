import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentMiddleware } from "@/agent/agent-middleware";
import { TodoSystem } from "@/agent/todos/todo-system";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

import { defineCodingAgent } from "../coding-agent";

const FINAL: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
};
const USER: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "inspect" }],
};

class RecordingProvider implements ModelProvider {
    readonly requests: ModelProviderInvokeParams[] = [];
    private readonly _responses: AssistantMessage[];
    private _cursor = 0;

    constructor(options: { responses: AssistantMessage[] }) {
        this._responses = options.responses;
    }

    async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
        this.requests.push(params);
        const response = this._responses[this._cursor++];
        if (!response) throw new Error("Script exhausted");
        return response;
    }

    async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
        yield await this.invoke(params);
    }
}

const workspaces: string[] = [];
afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runFixture(
    options: {
        guidance?: string;
        responses?: AssistantMessage[];
        todos?: TodoSystem;
        policyMiddleware?: AgentMiddleware;
    } = {},
) {
    const cwd = await mkdtemp(join(tmpdir(), "harness-agent-"));
    workspaces.push(cwd);
    if (options.guidance !== undefined) await Bun.write(join(cwd, "AGENTS.md"), options.guidance);
    const skillDirectory = join(cwd, ".agents", "skills", "test-writer");
    await mkdir(skillDirectory, { recursive: true });
    await Bun.write(
        join(skillDirectory, "SKILL.md"),
        "---\nname: test-writer\ndescription: Use for tests.\n---\nBODY_ONLY_AFTER_SELECTION\n",
    );
    const provider = new RecordingProvider({ responses: options.responses ?? [FINAL] });
    const agent = await defineCodingAgent({
        model: new Model({ name: "recording", provider }),
        cwd,
        todos: options.todos,
        policyMiddleware: options.policyMiddleware,
    });
    for await (const _event of agent.stream(USER)) {
        /* consume */
    }
    return { agent, provider };
}

describe("defineCodingAgent", () => {
    test("combines guidance, metadata and tools without polluting the transcript", async () => {
        const { agent, provider } = await runFixture({ guidance: "Always run tests." });
        const first = provider.requests[0]!;
        expect(JSON.stringify(first.messages[0])).toContain("Always run tests.");
        expect(JSON.stringify(first.messages[0])).toContain("test-writer");
        expect(JSON.stringify(first.messages)).not.toContain("BODY_ONLY_AFTER_SELECTION");
        expect(JSON.stringify(agent.messages)).not.toContain("Always run tests.");
        expect(first.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["read_file", "todo_write", "ask_user_question"]),
        );
    });

    test("shares the injected Todo store and applies Skills then Todo then policy", async () => {
        const todos = new TodoSystem({ reminderAfterSteps: 1 });
        const seen: string[] = [];
        await runFixture({
            todos,
            policyMiddleware: {
                beforeModel: async ({ modelContext }) => {
                    seen.push(modelContext.prompt);
                },
            },
            responses: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "todo-1",
                            name: "todo_write",
                            input: {
                                description: "track work",
                                merge: false,
                                items: [{ id: "a", text: "inspect", status: "pending" }],
                            },
                        },
                    ],
                },
                FINAL,
            ],
        });
        expect(todos.snapshot()).toEqual([{ id: "a", text: "inspect", status: "pending" }]);
        expect(seen).toHaveLength(2);
        expect(seen[0]).not.toContain("Review unfinished Todos");
        expect(seen[1]).toContain("Review unfinished Todos");
        expect(seen[1]!.indexOf("test-writer")).toBeLessThan(seen[1]!.indexOf("Review unfinished Todos"));
    });

    test("loads the selected Skill through a Tool result on the next model request", async () => {
        const { provider } = await runFixture({
            responses: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "skill-1",
                            name: "read_file",
                            input: {
                                description: "load selected Skill",
                                path: ".agents/skills/test-writer/SKILL.md",
                            },
                        },
                    ],
                },
                FINAL,
            ],
        });
        expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain("BODY_ONLY_AFTER_SELECTION");
        const observations = provider.requests[1]!.messages.filter((message) => message.role === "tool");
        expect(JSON.stringify(observations)).toContain("BODY_ONLY_AFTER_SELECTION");
        expect(observations[0]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "skill-1" });
    });
});
