import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readProjectGuidance } from "../project-guidance";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), "harness-guidance-"));
    roots.push(cwd);
    return cwd;
}

describe("project guidance", () => {
    test("treats a missing AGENTS.md as empty guidance", async () => {
        const warnings: string[] = [];
        expect(
            await readProjectGuidance({
                cwd: await workspace(),
                onWarning: (message) => warnings.push(message),
            }),
        ).toBe("");
        expect(warnings).toEqual([]);
    });

    test("truncates the injected text and reports the source path", async () => {
        const cwd = await workspace();
        const path = join(cwd, "AGENTS.md");
        await Bun.write(path, "123456");
        const warnings: string[] = [];
        expect(
            await readProjectGuidance({
                cwd,
                maxCharacters: 4,
                onWarning: (message) => warnings.push(message),
            }),
        ).toBe("1234");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(path);
        expect(await Bun.file(path).text()).toBe("123456");
    });
});
