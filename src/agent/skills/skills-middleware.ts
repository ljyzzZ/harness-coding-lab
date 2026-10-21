import type { AgentMiddleware } from "@/agent/agent-middleware";

import type { SkillDescriptor } from "./skill-reader";

export function defineSkillsMiddleware(options: { skills: SkillDescriptor[] }): AgentMiddleware {
    const catalog = options.skills.map(({ name, description, path }) => ({ name, description, path }));
    const instructions = "When a Skill is selected, first read its exact path with read_file. Do not guess by name.";
    return {
        beforeModel: async ({ modelContext }) => {
            // 无 Skill 时不修改本次请求，这是完整的空目录路径。
            if (catalog.length === 0) return;

            // TODO：返回 Partial<ModelContext>，只更新 prompt。
            // 保留 modelContext.prompt，追加目录标题、JSON.stringify(catalog) 和 instructions。
            // 此处不读 Skill 正文，也不修改传入的 context 或 transcript。
            return {
                prompt: [
                    modelContext.prompt,
                    "## Available Skills (metadata only):",
                    JSON.stringify(catalog),
                    instructions,
                ].join("\n\n"),
            };
        },
    };
}
