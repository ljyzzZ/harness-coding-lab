import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWorkspacePath } from "../tool-utils";

let workspace: string;
let outside: string;

beforeEach(async () => {
    // macOS 的 tmpdir() 可能经过 /var symlink；预期值也统一为真实路径。
    workspace = await realpath(await mkdtemp(join(tmpdir(), "harness-lab-tool-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "harness-lab-outside-")));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

describe("resolveWorkspacePath", () => {
    test("accepts relative, absolute and not-yet-created paths inside cwd", async () => {
        await mkdir(join(workspace, "src"));

        expect(
            await resolveWorkspacePath({ cwd: workspace, inputPath: "src/new.ts" }),
        ).toMatchObject({ ok: true, path: join(workspace, "src/new.ts") });
        expect(
            await resolveWorkspacePath({ cwd: workspace, inputPath: join(workspace, "src") }),
        ).toMatchObject({ ok: true, path: join(workspace, "src") });
    });

    test("rejects traversal and a directory with a similar prefix", async () => {
        expect(
            await resolveWorkspacePath({ cwd: workspace, inputPath: "../secret.txt" }),
        ).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
        expect(
            await resolveWorkspacePath({ cwd: workspace, inputPath: `${workspace}-other/file.ts` }),
        ).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
    });

    test("rejects a symlink whose real target is outside cwd", async () => {
        await symlink(outside, join(workspace, "escape"));

        expect(
            await resolveWorkspacePath({ cwd: workspace, inputPath: "escape/new.ts" }),
        ).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
    });
});
