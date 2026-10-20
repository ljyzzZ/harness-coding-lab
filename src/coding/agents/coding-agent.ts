import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { Agent } from "@/agent/agent";
import type { AgentMiddleware } from "@/agent/agent-middleware";
import { discoverSkills } from "@/agent/skills/skill-reader";
import { defineSkillsMiddleware } from "@/agent/skills/skills-middleware";
import { TodoSystem, defineTodoIntegration } from "@/agent/todos/todo-system";
import { defineCodingTools } from "@/coding/tools";
import { defineAskUserQuestionTool } from "@/coding/tools/ask-user-question";
import type { AskUserQuestionHandler } from "@/coding/tools/ask-user-question";
import type { Model } from "@/foundation/models";

import { readProjectGuidance } from "./project-guidance";

export async function defineCodingAgent(options: {
    model: Model;
    cwd?: string;
    skillsDirs?: string[];
    askUserQuestion?: AskUserQuestionHandler;
    policyMiddleware?: AgentMiddleware;
    maxGuidanceCharacters?: number;
    onWarning?: (message: string) => void;
    todos?: TodoSystem;
}): Promise<Agent> {
    const cwd = await realpath(options.cwd ?? process.cwd());
    const warn = options.onWarning ?? ((message: string) => console.warn(message));
    const guidance = await readProjectGuidance({
        cwd,
        maxCharacters: options.maxGuidanceCharacters,
        onWarning: warn,
    });
    const { skills, warnings } = await discoverSkills({
        directories: options.skillsDirs ?? [join(cwd, ".agents", "skills")],
    });
    warnings.forEach(warn);
    const todos = options.todos ?? new TodoSystem({ reminderAfterSteps: 3 });
    const todo = defineTodoIntegration(todos);

    const promptParts = [
        "You are a coding assistant. Inspect files before editing and verify your changes.",
        `Workspace: ${cwd}`,
    ];
    const tools = defineCodingTools({ cwd });
    const middlewares: AgentMiddleware[] = [];
    const questionTool = defineAskUserQuestionTool({
        handler:
            options.askUserQuestion ??
            (async () => {
                throw new Error("No user input handler is connected");
            }),
    });

    // TODO 1：guidance 非空时加入 promptParts，并标明内容来自 AGENTS.md。
    // 只通过 prompt 传入 Model view；不要为它创建 user message。
    if (guidance) {
        promptParts.push(`AGENTS.md: ${guidance}`);
    }

    // TODO 2：补齐两个数组：tools 还需要 todo.tool 和 questionTool；
    // middlewares 按 Skills → Todo → 可选 policy 的顺序加入对应实例。
    // 使用上面同一个 todo 的 tool/middleware，不要在这里再创建 TodoSystem。
    tools.push(todo.tool, questionTool);

    middlewares.push(defineSkillsMiddleware({ skills }), todo.middleware);

    if (options.policyMiddleware) {
        middlewares.push(options.policyMiddleware);
    }

    return new Agent({
        model: options.model,
        prompt: promptParts.join("\n\n"),
        tools,
        middlewares,
    });
}
