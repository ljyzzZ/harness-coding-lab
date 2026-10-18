import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverSkills, readSkill } from "../skill-reader";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "harness-skills-"));
    roots.push(root);
    await mkdir(join(root, "valid"));
    await mkdir(join(root, "broken"));
    await writeFile(
        join(root, "valid", "SKILL.md"),
        [
            "---",
            "name: test-writer",
            "description: Use when writing tests.",
            "---",
            "",
            "# Test Writer",
            "Full instructions",
        ].join("\n"),
    );
    await writeFile(join(root, "broken", "SKILL.md"), "---\nname: broken\n");
    return root;
}

describe("Skill reader", () => {
    test("returns no skills for a missing directory", async () => {
        const result = await discoverSkills({ directories: ["/definitely/missing"] });
        expect(result.skills).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    test("discovers metadata but loads full content only when selected", async () => {
        const root = await fixture();
        const result = await discoverSkills({ directories: [root] });

        expect(result.skills).toHaveLength(1);
        expect(result.skills[0]).toMatchObject({
            name: "test-writer",
            description: "Use when writing tests.",
        });
        expect(JSON.stringify(result.skills)).not.toContain("Full instructions");
        expect((await readSkill({ descriptor: result.skills[0]! })).content).toContain("Full instructions");
        expect(result.warnings.join("\n")).toContain("broken");
    });

    test("deduplicates real paths but keeps distinct files with the same name", async () => {
        const root = await fixture();
        await mkdir(join(root, "another"));
        await writeFile(join(root, "another", "SKILL.md"), await Bun.file(join(root, "valid", "SKILL.md")).text());
        const result = await discoverSkills({ directories: [root, root] });
        expect(result.skills.filter((skill) => skill.name === "test-writer")).toHaveLength(2);
        expect(new Set(result.skills.map((skill) => skill.path)).size).toBe(2);
    });

    test("loads the selected path and reports truncation at the exact boundary", async () => {
        const root = await fixture();
        const { skills } = await discoverSkills({ directories: [root] });
        const descriptor = skills[0]!;
        const full = await readSkill({ descriptor });
        expect(await readSkill({ descriptor, maxCharacters: full.content.length })).toEqual({
            content: full.content,
            truncated: false,
        });
        expect(await readSkill({ descriptor, maxCharacters: 4 })).toEqual({
            content: full.content.slice(0, 4),
            truncated: true,
        });
        const alternate = join(root, "alternate.md");
        await writeFile(alternate, "Selected exact file");
        expect((await readSkill({ descriptor: { ...descriptor, path: alternate } })).content).toBe(
            "Selected exact file",
        );
    });
});
