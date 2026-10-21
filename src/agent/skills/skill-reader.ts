import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

export interface SkillDescriptor {
    name: string;
    description: string;
    path: string;
}

const skillMetadataSchema = z.object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
});

function parseSkillDescriptor(text: string, path: string, limit: number): SkillDescriptor {
    // 文件必须从 frontmatter 开始；同时接受 LF 和 CRLF。
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error("Missing or unclosed frontmatter");
    const frontmatter = match[1]!;
    if (frontmatter.length > limit) throw new Error("Frontmatter exceeds character limit");
    const metadata = skillMetadataSchema.parse(parse(frontmatter));
    return { name: metadata.name, description: metadata.description, path };
}

export async function discoverSkills(options: {
    directories: string[];
    maxFrontmatterCharacters?: number;
}): Promise<{ skills: SkillDescriptor[]; warnings: string[] }> {
    const skills: SkillDescriptor[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const limit = options.maxFrontmatterCharacters ?? 4_000;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid frontmatter limit");

    for (const directory of options.directories) {
        try {
            const entries = await readdir(directory, { withFileTypes: true });
            // directory 按传入顺序，子目录按名称排序，让提示词与测试稳定。
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                if (!entry.isDirectory()) continue;
                const candidate = join(directory, entry.name, "SKILL.md");
                try {
                    const path = await realpath(candidate);
                    if (seen.has(path)) continue;
                    seen.add(path);
                    skills.push(parseSkillDescriptor(await Bun.file(path).text(), path, limit));
                } catch (error) {
                    if ((error as { code?: string }).code !== "ENOENT") {
                        warnings.push(`${candidate}: ${String(error)}`);
                    }
                }
            }
        } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") {
                warnings.push(`${directory}: ${String(error)}`);
            }
        }
    }
    return { skills, warnings };
}

export async function readSkill(options: {
    descriptor: SkillDescriptor;
    maxCharacters?: number;
}): Promise<{ content: string; truncated: boolean }> {
    const limit = options.maxCharacters ?? 20_000;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid Skill content limit");
    const content = await Bun.file(options.descriptor.path).text();
    return { content: content.slice(0, limit), truncated: content.length > limit };
}
