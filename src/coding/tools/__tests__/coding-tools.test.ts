import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineCodingTools } from "../index";

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "harness-lab-tools-"));
    await writeFile(join(workspace, "input.ts"), "const value = 1;\n", "utf8");
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

async function invoke(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    limits: { maxOutputCharacters?: number; maxResults?: number; bashTimeoutMs?: number } = {},
) {
    const tool = defineCodingTools({ cwd: workspace, bashTimeoutMs: 100, ...limits }).find(
        (candidate) => candidate.name === name,
    );
    if (!tool) throw new Error(`Missing test Tool: ${name}`);
    return tool.invoke({ description: `test ${name}`, ...input } as never, signal);
}

describe("read-only coding tools", () => {
    test("file_info, list_files, glob_search and grep_search expose bounded data", async () => {
        expect(await invoke("file_info", { path: "input.ts" })).toMatchObject({
            ok: true,
            data: { type: "file", size: new TextEncoder().encode("const value = 1;\n").length },
        });
        expect(await invoke("list_files", { path: "." })).toMatchObject({
            ok: true,
            data: { entries: ["input.ts"], truncated: false },
        });
        expect(await invoke("glob_search", { path: ".", pattern: "**/*.ts" })).toMatchObject({
            ok: true,
            data: { paths: ["input.ts"], truncated: false },
        });
        expect(await invoke("grep_search", { path: ".", pattern: "value" })).toMatchObject({
            ok: true,
            data: {
                matches: [{ path: "input.ts", line: 1, text: "const value = 1;" }],
                truncated: false,
            },
        });
        for (const name of ["file_info", "list_files", "glob_search", "grep_search"]) {
            expect(await invoke(name, { path: "missing", pattern: "value" })).toMatchObject({
                ok: false,
                code: "FILE_NOT_FOUND",
            });
        }
    });

    test("limits search results and marks truncated output", async () => {
        await writeFile(join(workspace, "second.ts"), "const value = 2;\n", "utf8");
        const limits = { maxResults: 1 };
        expect(await invoke("list_files", { path: "." }, undefined, limits)).toMatchObject({
            data: { entries: ["input.ts"], truncated: true },
        });
        expect(await invoke("glob_search", { path: ".", pattern: "**/*.ts" }, undefined, limits)).toMatchObject({
            data: { paths: ["input.ts"], truncated: true },
        });
        expect(await invoke("grep_search", { path: ".", pattern: "value" }, undefined, limits)).toMatchObject({
            data: {
                matches: [{ path: "input.ts", line: 1, text: "const value = 1;" }],
                truncated: true,
            },
        });
    });

    test("read_file validates ranges and rejects traversal", async () => {
        expect(await invoke("read_file", { path: "input.ts", startLine: 1, endLine: 1 })).toMatchObject({
            ok: true,
            data: { content: "1: const value = 1;", truncated: false },
        });
        expect(await invoke("read_file", { path: "input.ts" })).toMatchObject({
            data: { content: "const value = 1;\n", truncated: false },
        });
        expect(await invoke("read_file", { path: "input.ts" }, undefined, { maxOutputCharacters: 5 })).toMatchObject({
            data: { content: "const\n[truncated]", truncated: true },
        });
        expect(await invoke("read_file", { path: "input.ts", startLine: 1 })).toMatchObject({
            ok: false,
            code: "INVALID_LINE_RANGE",
        });
        expect(await invoke("read_file", { path: "input.ts", startLine: 2, endLine: 1 })).toMatchObject({
            ok: false,
            code: "INVALID_LINE_RANGE",
        });
        expect(await invoke("read_file", { path: "../outside.ts" })).toMatchObject({
            ok: false,
            code: "PATH_OUTSIDE_WORKSPACE",
        });
    });
});

describe("mutating coding tools", () => {
    test("mkdir, write_file and move_path produce observable side effects", async () => {
        expect(await invoke("mkdir", { path: "src" })).toMatchObject({ ok: true });
        expect(await invoke("write_file", { path: "src/a.ts", content: "export {};\n" })).toMatchObject({ ok: true });
        expect(await invoke("move_path", { from: "src/a.ts", to: "src/b.ts" })).toMatchObject({ ok: true });
        expect(await readFile(join(workspace, "src/b.ts"), "utf8")).toBe("export {};\n");
        await expect(access(join(workspace, "src/a.ts"))).rejects.toBeDefined();
        expect(await invoke("move_path", { from: "missing.ts", to: "unused.ts" })).toMatchObject({
            ok: false,
            code: "FILE_NOT_FOUND",
        });
        expect(await invoke("write_file", { path: "../outside.ts", content: "bad" })).toMatchObject({
            ok: false,
            code: "PATH_OUTSIDE_WORKSPACE",
        });
    });

    test("str_replace refuses zero and ambiguous matches", async () => {
        await writeFile(join(workspace, "input.ts"), "same\nsame\n", "utf8");

        expect(await invoke("str_replace", { path: "input.ts", oldText: "missing", newText: "x" })).toMatchObject({
            ok: false,
            code: "PATTERN_NOT_FOUND",
        });
        expect(await invoke("str_replace", { path: "input.ts", oldText: "same", newText: "x" })).toMatchObject({
            ok: false,
            code: "AMBIGUOUS_REPLACEMENT",
        });
        expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("same\nsame\n");
    });

    test("str_replace writes exactly the requested literal replacement", async () => {
        expect(await invoke("str_replace", { path: "input.ts", oldText: "1", newText: "$&" })).toMatchObject({
            ok: true,
        });
        expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("const value = $&;\n");
    });

    test("apply_patch applies a valid patch and diagnoses an invalid one", async () => {
        const patch = [
            "--- a/input.ts",
            "+++ b/input.ts",
            "@@ -1 +1 @@",
            "-const value = 1;",
            "+const value = 2;",
        ].join("\n");

        expect(await invoke("apply_patch", { patch })).toMatchObject({ ok: true });
        expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("const value = 2;\n");
        expect(await invoke("apply_patch", { patch: "not a patch" })).toMatchObject({
            ok: false,
            code: "PATCH_APPLY_FAILED",
        });
        expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("const value = 2;\n");
    });
});

describe("bash", () => {
    test("captures success and non-zero exit", async () => {
        expect(await invoke("bash", { command: "printf ok; printf err >&2" })).toMatchObject({
            ok: true,
            data: { stdout: "ok", stderr: "err", exitCode: 0 },
        });
        expect(await invoke("bash", { command: "exit 7" })).toMatchObject({ ok: false, code: "COMMAND_FAILED" });
    });

    test("reports timeout and observes a pre-aborted signal", async () => {
        expect(await invoke("bash", { command: "sleep 1" })).toMatchObject({ ok: false, code: "COMMAND_TIMED_OUT" });

        const controller = new AbortController();
        controller.abort();
        expect(await invoke("bash", { command: "printf unexpected" }, controller.signal)).toMatchObject({
            ok: false,
            code: "ABORTED",
        });
    });

    test("drains large process output while retaining only a bounded prefix", async () => {
        expect(
            await invoke("bash", { command: "printf '%1048576s' '' | tr ' ' x" }, undefined, {
                maxOutputCharacters: 8,
                bashTimeoutMs: 2000,
            }),
        ).toMatchObject({ ok: true, data: { stdout: "xxxxxxxx\n[truncated]", truncated: true } });
    });

    test("abort and timeout stop a running descendant before it writes", async () => {
        for (const reason of ["abort", "timeout"] as const) {
            const controller = new AbortController();
            const command = `touch ready-${reason}; (sleep 0.4; printf unexpected > late-${reason}) & wait`;
            const result = invoke("bash", { command }, controller.signal, { bashTimeoutMs: 200 });
            // 等真实进程启动，避免把运行中中止退化成 pre-aborted 测试。
            const deadline = performance.now() + 1000;
            while (!(await Bun.file(join(workspace, `ready-${reason}`)).exists())) {
                if (performance.now() > deadline) {
                    controller.abort();
                    await result;
                    throw new Error("bash did not start within the test deadline");
                }
                await Bun.sleep(5);
            }
            if (reason === "abort") controller.abort();
            expect(await result).toMatchObject({
                ok: false,
                code: reason === "abort" ? "ABORTED" : "COMMAND_TIMED_OUT",
            });
            await Bun.sleep(450);
            expect(await Bun.file(join(workspace, `late-${reason}`)).exists()).toBe(false);
        }
    });
});
