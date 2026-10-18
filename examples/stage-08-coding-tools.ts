import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineCodingTools } from "@/coding/tools";

type Mode = "inspect" | "edit" | "reject-path";
type WorkspaceSnapshot = Record<string, string>;

const trackedPaths = ["input.ts", "notes.txt"];

async function snapshot(cwd: string): Promise<WorkspaceSnapshot> {
    const result: WorkspaceSnapshot = {};
    for (const path of trackedPaths) {
        try {
            result[path] = await readFile(join(cwd, path), "utf8");
        } catch {
            // 文件尚不存在时不写入 snapshot。
        }
    }
    return result;
}

function printDiff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): void {
    const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    let changed = false;

    for (const path of paths) {
        if (before[path] === after[path]) continue;
        changed = true;
        console.log(`--- before/${path}`);
        console.log(`+++ after/${path}`);
        if (before[path] !== undefined) console.log(`-${before[path]!.trimEnd()}`);
        if (after[path] !== undefined) console.log(`+${after[path]!.trimEnd()}`);
    }

    if (!changed) console.log("(no workspace changes)");
}

async function main(): Promise<void> {
    const mode = Bun.argv[2];
    if (mode !== "inspect" && mode !== "edit" && mode !== "reject-path") {
        console.log("Usage: bun run examples/stage-08-coding-tools.ts <inspect|edit|reject-path>");
        return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "harness-tools-demo-"));
    try {
        await writeFile(join(workspace, "input.ts"), "export const value = 1;\n", "utf8");
        const before = await snapshot(workspace);
        const tools = defineCodingTools({ cwd: workspace, bashTimeoutMs: 1_000 });
        const invoke = async (name: string, input: Record<string, unknown>) => {
            const tool = tools.find((candidate) => candidate.name === name);
            if (!tool) throw new Error(`Missing coding Tool: ${name}`);
            const result = await tool.invoke({ description: `demo ${name}`, ...input } as never);
            console.log(`${name}: ${JSON.stringify(result, null, 2)}`);
            return result;
        };

        if (mode === "inspect") {
            await invoke("list_files", { path: "." });
            await invoke("read_file", { path: "input.ts" });
            await invoke("grep_search", { path: ".", pattern: "value" });
        } else if (mode === "edit") {
            await invoke("str_replace", {
                path: "input.ts",
                oldText: "value = 1",
                newText: "value = 2",
            });
            await invoke("write_file", {
                path: "notes.txt",
                content: "updated by stage-08-coding-tools\n",
            });
        } else {
            await invoke("read_file", { path: "../outside.txt" });
        }

        console.log("workspace diff:");
        printDiff(before, await snapshot(workspace));
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

await main();
