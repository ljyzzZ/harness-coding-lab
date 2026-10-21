import { describe, expect, test } from "bun:test";

import type { AgentContext } from "@/agent/agent-context";
import type { ModelContext } from "@/foundation/models/model-context";

import { defineSkillsMiddleware } from "../skills-middleware";

function contexts(): { agentContext: AgentContext; modelContext: ModelContext } {
    const agentContext: AgentContext = {
        prompt: "Keep the project guidance.",
        messages: [{ role: "user", content: [{ type: "text", text: "add a test" }] }],
    };
    return { agentContext, modelContext: { ...agentContext } };
}

const SKILL = {
    name: "test-writer",
    description: "Use when adding tests.",
    path: "/workspace/.agents/skills/test-writer/SKILL.md",
};

describe("Skills Middleware", () => {
    test("leaves an empty catalog alone", async () => {
        const middleware = defineSkillsMiddleware({ skills: [] });
        expect(await middleware.beforeModel!(contexts())).toBeUndefined();
    });

    test("returns a temporary prompt without mutating either context", async () => {
        const middleware = defineSkillsMiddleware({ skills: [SKILL] });
        const input = contexts();
        const original = structuredClone(input);
        const update = await middleware.beforeModel!(input);
        expect(update?.prompt).toContain("Keep the project guidance.");
        expect(update?.prompt).toContain(SKILL.name);
        expect(update?.prompt).toContain(SKILL.path);
        expect(update?.prompt).toContain("read_file");
        expect(update?.messages).toBeUndefined();
        expect(input).toEqual(original);

        // 模拟 host 将返回值合并到本次 ModelContext，再从 canonical context（基准上下文）准备下一次请求。
        const firstView = { ...input.modelContext, ...update };
        const nextContext = { ...input.agentContext };
        const nextUpdate = await middleware.beforeModel!({
            agentContext: input.agentContext,
            modelContext: nextContext,
        });
        expect({ ...nextContext, ...nextUpdate }).toEqual(firstView);
    });
});
