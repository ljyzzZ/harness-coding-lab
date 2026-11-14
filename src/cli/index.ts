import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { TodoSystem } from "@/agent/todos/todo-system";
import { defineCodingAgent } from "@/coding/agents/coding-agent";
import { defineApprovalMiddleware } from "@/coding/permissions/approval-middleware";
import { defineApprovalPersistence } from "@/coding/permissions/approval-persistence";

import { defineConfiguredModel } from "./config/model-factory";
import { requireConfig } from "./config/config-file";
import { registerModelCommands } from "./config/model-commands";
import { mountApp } from "./tui/app";
import { HumanInputQueue } from "./tui/human-input";

export async function startChat(configPath: string): Promise<void> {
    const config = await requireConfig(configPath);
    const model = defineConfiguredModel(config);
    const cwd = await realpath(process.cwd());
    const persistence = defineApprovalPersistence({
        path: join(homedir(), ".config", "harness-lab", "approvals.json"),
    });
    const humanInput = new HumanInputQueue();
    const todos = new TodoSystem({ reminderAfterSteps: 3 });
    const policyMiddleware = defineApprovalMiddleware({
        projectId: cwd,
        maxQueueLength: 8,
        persistence,
        requestDecision: async (request, signal) => {
            const answer = await humanInput.request({ kind: "approval", request }, signal);
            if (answer === "allow_once" || answer === "allow_always_project" || answer === "deny") return answer;
            return "deny";
        },
    });
    const agent = await defineCodingAgent({
        cwd,
        model,
        todos,
        policyMiddleware,
        askUserQuestion: async ({ question, choices, signal }) => ({
            answer: await humanInput.request({ kind: "question", question, choices }, signal),
        }),
    });
    await mountApp({ agent, todos, humanInput, modelName: model.name }).waitUntilExit();
}

export async function main(argv: string[] = Bun.argv): Promise<void> {
    const program = new Command();
    program
        .name("harness-lab")
        .option("-c, --config <path>", "model config file", "harness.config.yaml")
        .action(async (options: { config: string }) => {
            await startChat(options.config);
        });
    registerModelCommands(program);
    await program.parseAsync(argv);
}

if (import.meta.main) await main();
