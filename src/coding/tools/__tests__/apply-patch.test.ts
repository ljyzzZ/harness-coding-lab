import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineApplyPatchTool } from "../apply-patch";

let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "harness-patch-")));
    workspace = join(root, "workspace");
    outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function patch(oldPath: string, newPath: string, body: string): string {
    return `--- ${oldPath}\n+++ ${newPath}\n${body}`;
}

function apply(diff: string, signal?: AbortSignal) {
    return defineApplyPatchTool({ cwd: workspace }).invoke({ description: "Apply test patch", patch: diff }, signal);
}

describe("apply_patch", () => {
    test.each([
        {
            name: "context and untouched surrounding lines",
            original: "before\nkeep\nold\nafter\n",
            body: "@@ -2,2 +2,3 @@\n keep\n-old\n+new\n+extra\n",
            expected: "before\nkeep\nnew\nextra\nafter\n",
        },
        {
            name: "multiple hunks using original coordinates and shifted new coordinates",
            original: "one\ntwo\nthree\nfour\n",
            body: "@@ -1 +1,2 @@\n one\n+insert\n@@ -3 +4 @@\n-three\n+THREE\n",
            expected: "one\ninsert\ntwo\nTHREE\nfour\n",
        },
        {
            name: "insertion before the first line",
            original: "tail\n",
            body: "@@ -0,0 +1 @@\n+head\n",
            expected: "head\ntail\n",
        },
        {
            name: "insertion between lines",
            original: "first\nlast\n",
            body: "@@ -1,0 +2 @@\n+middle\n",
            expected: "first\nmiddle\nlast\n",
        },
        {
            name: "insertion after the last line",
            original: "first\nlast\n",
            body: "@@ -2,0 +3 @@\n+end\n",
            expected: "first\nlast\nend\n",
        },
        {
            name: "deleting all lines leaves an empty file",
            original: "old\n",
            body: "@@ -1 +0,0 @@\n-old\n",
            expected: "",
        },
        {
            name: "preserving the absence of a trailing newline",
            original: "old",
            body: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
            expected: "new",
        },
        {
            name: "preserving CRLF line endings",
            original: "keep\r\nold\r\n",
            body: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n",
            expected: "keep\r\nnew\r\n",
        },
        {
            name: "inserting into an empty file follows its trailing-newline convention",
            original: "",
            body: "@@ -0,0 +1 @@\n+new\n",
            expected: "new",
        },
    ])("applies $name", async ({ original, body, expected }) => {
        const path = join(workspace, "file.txt");
        await Bun.write(path, original);
        expect(await apply(patch("a/file.txt", "b/file.txt", body))).toMatchObject({
            ok: true, data: { paths: [path] },
        });
        expect(await Bun.file(path).text()).toBe(expected);
    });

    test.each([
        ["oldStart zero with a nonempty range", "@@ -0 +1 @@\n one\n"],
        ["newStart zero with a nonempty range", "@@ -1 +0 @@\n one\n"],
        ["start beyond the original file", "@@ -4 +4 @@\n one\n"],
        ["range extending beyond the original file", "@@ -2,2 +2,2 @@\n two\n three\n"],
        ["insertion beyond the original file", "@@ -3,0 +4 @@\n+extra\n"],
        ["inconsistent newStart", "@@ -1 +2 @@\n one\n"],
        ["overlapping hunks", "@@ -1 +1 @@\n one\n@@ -1 +2 @@\n one\n"],
        ["out-of-order hunks", "@@ -2 +2 @@\n two\n@@ -1 +1 @@\n one\n"],
        ["unsafe oldStart", "@@ -9007199254740992 +1 @@\n one\n"],
        ["unsafe newStart", "@@ -1 +9007199254740992 @@\n one\n"],
        ["mismatching context", "@@ -1 +1 @@\n different\n"],
        ["mismatching deletion", "@@ -1 +1 @@\n-wrong\n+new\n"],
        ["incorrect oldCount", "@@ -1,2 +1 @@\n-one\n+new\n"],
        ["incorrect newCount", "@@ -1 +1 @@\n-one\n+new\n+extra\n"],
        ["missing hunks", ""],
    ])("rejects %s without changing the file", async (_name, body) => {
        const path = join(workspace, "file.txt");
        await Bun.write(path, "one\ntwo\n");
        expect(await apply(patch("a/file.txt", "b/file.txt", body!))).toMatchObject({
            ok: false, code: "PATCH_APPLY_FAILED",
        });
        expect(await Bun.file(path).text()).toBe("one\ntwo\n");
    });

    test("creates a new file and its parent directories", async () => {
        const path = join(workspace, "nested/new.txt");
        const diff = patch("/dev/null", "b/nested/new.txt", "@@ -0,0 +1,2 @@\n+first\n+second\n");
        expect(await apply(diff)).toMatchObject({ ok: true, data: { paths: [path] } });
        expect(await Bun.file(path).text()).toBe("first\nsecond");
    });

    test("updates multiple files and reports their resolved paths", async () => {
        await Bun.write(join(workspace, "first.txt"), "old\n");
        await Bun.write(join(workspace, "second.txt"), "old\n");
        const body = "@@ -1 +1 @@\n-old\n+new\n";
        const diff = patch("a/first.txt", "b/first.txt", body) + patch("a/second.txt", "b/second.txt", body);
        expect(await apply(diff)).toMatchObject({
            ok: true, data: { paths: [join(workspace, "first.txt"), join(workspace, "second.txt")] },
        });
        expect(await Bun.file(join(workspace, "first.txt")).text()).toBe("new\n");
        expect(await Bun.file(join(workspace, "second.txt")).text()).toBe("new\n");
    });

    test("validates every file before writing any changes", async () => {
        await Bun.write(join(workspace, "existing.txt"), "old\n");
        const diff = patch("/dev/null", "b/nested/new.txt", "@@ -0,0 +1 @@\n+new\n") +
            patch("a/existing.txt", "b/existing.txt", "@@ -1 +1 @@\n-wrong\n+new\n");
        expect(await apply(diff)).toMatchObject({ ok: false, code: "PATCH_APPLY_FAILED" });
        expect(await Bun.file(join(workspace, "nested/new.txt")).exists()).toBe(false);
        expect(await Bun.file(join(workspace, "existing.txt")).text()).toBe("old\n");
    });

    test.each([
        ["../outside/file.txt", "b/new.txt"],
        ["a/file.txt", "../outside/file.txt"],
        ["a/escape/file.txt", "b/new.txt"],
        ["a/file.txt", "b/escape/file.txt"],
    ])("rejects an escaping path: %s -> %s", async (oldPath, newPath) => {
        await Bun.write(join(workspace, "file.txt"), "old\n");
        await Bun.write(join(outside, "file.txt"), "old\n");
        await symlink(outside, join(workspace, "escape"));
        const diff = patch(oldPath!, newPath!, "@@ -1 +1 @@\n-old\n+new\n");
        expect(await apply(diff)).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
        expect(await Bun.file(join(workspace, "file.txt")).text()).toBe("old\n");
        expect(await Bun.file(join(outside, "file.txt")).text()).toBe("old\n");
        expect(await Bun.file(join(workspace, "new.txt")).exists()).toBe(false);
    });

    test("rejects deletion without removing the file", async () => {
        const path = join(workspace, "file.txt");
        await Bun.write(path, "old\n");
        expect(await apply(patch("a/file.txt", "/dev/null", "@@ -1 +0,0 @@\n-old\n"))).toMatchObject({
            ok: false, code: "PATCH_APPLY_FAILED",
        });
        expect(await Bun.file(path).text()).toBe("old\n");
    });

    test("does not overwrite an existing file with an add-file patch", async () => {
        const path = join(workspace, "file.txt");
        await Bun.write(path, "keep\n");
        expect(await apply(patch("/dev/null", "b/file.txt", "@@ -0,0 +1 @@\n+new\n"))).toMatchObject({
            ok: false, code: "PATCH_APPLY_FAILED",
        });
        expect(await Bun.file(path).text()).toBe("keep\n");
    });

    test("rejects duplicate resolved targets before writing", async () => {
        const path = join(workspace, "file.txt");
        await Bun.write(path, "old\n");
        const diff = patch("a/file.txt", "b/file.txt", "@@ -1 +1 @@\n-old\n+new\n");
        expect(await apply(diff + diff)).toMatchObject({ ok: false, code: "PATCH_APPLY_FAILED" });
        expect(await Bun.file(path).text()).toBe("old\n");
    });

    test("preserves the missing-file error code", async () => {
        expect(await apply(patch("a/missing.txt", "b/missing.txt", "@@ -1 +1 @@\n-old\n+new\n")))
            .toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
        expect(await Bun.file(join(workspace, "missing.txt")).exists()).toBe(false);
    });

    test("does not create files after cancellation", async () => {
        const controller = new AbortController();
        controller.abort();
        const diff = patch("/dev/null", "b/new.txt", "@@ -0,0 +1 @@\n+new\n");
        expect(await apply(diff, controller.signal)).toMatchObject({ ok: false, code: "ABORTED" });
        expect(await Bun.file(join(workspace, "new.txt")).exists()).toBe(false);
    });

    test("rejects patches without file headers", async () => {
        expect(await apply("")).toMatchObject({ ok: false, code: "PATCH_APPLY_FAILED" });
    });
});
