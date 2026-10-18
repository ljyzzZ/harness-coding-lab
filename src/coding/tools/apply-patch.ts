import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

interface PatchHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: { kind: "context" | "delete" | "add"; text: string }[];
}

interface PatchFile {
    oldPath: string;
    newPath: string;
    hunks: PatchHunk[];
}

function parsePatch(patch: string): PatchFile[] {
    // 一个 patch 可以修改多个文件；先拆成行，再逐个收集文件信息。
    const lines = patch.split(/\r?\n/);
    const files: PatchFile[] = [];
    // 记录当前文件，将解析出的 hunk 放进它的 hunks。
    let currentFile: PatchFile | undefined;

    const readHeaderPath = (header: string): string => {
        // "--- " 和 "+++ " 都占 4 个字符；制表符后可能附带时间戳。
        // 只按制表符拆分，保留文件名中合法的空格。
        const rawPath = header.slice(4).split("\t")[0] ?? "";
        // 只删除开头的 a/ 或 b/；/dev/null 和没有这些前缀的路径保持原样。
        const path = rawPath.replace(/^[ab]\//, "");
        if (path === "") throw new Error("Missing path in patch file header");
        return path;
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];

        if (line?.startsWith("--- ")) {
            // 文件头必须成对出现：先是旧路径，再是新路径。
            const newHeader = lines[index + 1];
            if (!newHeader?.startsWith("+++ ")) {
                throw new Error("Expected +++ file header after --- file header");
            }

            currentFile = {
                oldPath: readHeaderPath(line),
                newPath: readHeaderPath(newHeader),
                hunks: [],
            };
            files.push(currentFile);

            // +++ 行已在上面处理；加上 for 自身的 index++，下一轮从它后面开始。
            index++;
            continue;
        }

        const header = line?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!header) continue;
        if (!currentFile) throw new Error("Hunk found before file headers");

        const hunk: PatchHunk = {
            oldStart: Number(header[1]),
            oldCount: Number(header[2] ?? 1),
            newStart: Number(header[3]),
            newCount: Number(header[4] ?? 1),
            lines: [],
        };
        let oldLines = 0;
        let newLines = 0;

        while (index + 1 < lines.length) {
            const body = lines[index + 1]!;
            // 行数已满足时，成对的 ---/+++ 才作为下一份文件头处理。
            if (
                oldLines >= hunk.oldCount && newLines >= hunk.newCount &&
                body.startsWith("--- ") && lines[index + 2]?.startsWith("+++ ")
            ) break;
            if (body === "\\ No newline at end of file") {
                index++;
                continue;
            }

            const kind = body[0] === " " ? "context" : body[0] === "-" ? "delete" : body[0] === "+" ? "add" : undefined;
            if (!kind) break;

            hunk.lines.push({ kind, text: body.slice(1) });
            if (kind !== "add") oldLines++;
            if (kind !== "delete") newLines++;
            index++;
        }
        // 复用扫描时的计数，确认正文与 header 声明的旧、新行数一致。
        if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
            throw new Error(`Hunk line count mismatch in ${currentFile.newPath}`);
        }
        currentFile.hunks.push(hunk);
    }

    if (files.length === 0) throw new Error("Patch contains no file headers");
    for (const file of files) {
        if (file.hunks.length === 0) throw new Error(`No hunks found for ${file.newPath}`);
    }
    return files;
}

function applyHunks(original: string, hunks: PatchHunk[]): string {
    // 将原文按行拆分，记录原文是否以换行结尾；末尾空项不作为正文行。
    const hasTrailingNewline = original.endsWith("\n");
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const source = original === "" ? [] : original.split(/\r?\n/);
    if (hasTrailingNewline) source.pop();

    // 保持 sourceIndex 和 output；先拷贝 hunk 前未改动的原文行。
    // oldStart 是 1-based；空文件插入 hunk 的 oldStart=0。当前位置已越过 hunk 时拒绝。
    let sourceIndex = 0;
    const output: string[] = [];
    for (const hunk of hunks) {
        if (
            ![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(Number.isSafeInteger) ||
            hunk.oldCount < 0 || hunk.newCount < 0 ||
            hunk.oldStart < (hunk.oldCount === 0 ? 0 : 1) ||
            hunk.newStart < (hunk.newCount === 0 ? 0 : 1)
        ) {
            throw new Error("Invalid hunk range");
        }

        // count=0 表示在 start 行之后插入；此时 start 已是对应的数组位置。
        const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
        const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
        if (oldIndex < sourceIndex || oldIndex + hunk.oldCount > source.length) {
            throw new Error("Hunk overlaps a previous hunk or exceeds the original file");
        }
        while (sourceIndex < oldIndex) output.push(source[sourceIndex++]!);
        // 未改动的前文复制完后，输出长度应与 header 声明的新文件位置一致。
        if (output.length !== newIndex) throw new Error("Hunk newStart does not match output position");

        // context/delete 行必须与 source[sourceIndex] 相等，否则 throw。
        // context 拷贝并前移，delete 只前移，add 只追加；后续 hunk 的坐标仍以原文为基准。
        for (const line of hunk.lines) {
            if (line.kind === "add") {
                output.push(line.text);
                continue;
            }
            if (source[sourceIndex] !== line.text) {
                throw new Error(`Patch content mismatch at original line ${sourceIndex + 1}`);
            }
            if (line.kind === "context") output.push(line.text);
            sourceIndex++;
        }
    }

    // 拷贝原文剩余行，join("\n") 并保留原文末尾换行。
    while (sourceIndex < source.length) output.push(source[sourceIndex++]!);
    // 沿用原文的 LF/CRLF 和末尾换行约定；删光正文时返回空字符串。
    const content = output.join(newline);
    return output.length > 0 && hasTrailingNewline ? content + newline : content;
}

export function defineApplyPatchTool(options: { cwd: string }) {
    return defineTool({
        name: "apply_patch",
        description: "Apply a unified diff patch inside the workspace",
        parameters: z.object({ description: z.string(), patch: z.string() }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const files = parsePatch(input.patch);
                const changes: { path: string; content: string }[] = [];
                const targets = new Set<string>();
                // 逐个文件验证 oldPath/newPath 的 workspace 边界（跳过 /dev/null），失败时保留原 code 返回。
                // 用 resolveWorkspacePath({ cwd: options.cwd, inputPath: file.newPath })，不要直接信任 patch 路径。
                for (const file of files) {
                    signal?.throwIfAborted();
                    const source = file.oldPath === "/dev/null" ? null : await resolveWorkspacePath({
                        cwd: options.cwd, inputPath: file.oldPath,
                    });
                    if (source && !source.ok) return errorToolResult(source.error, source.error, source.code);
                    const target = file.newPath === "/dev/null" ? null : await resolveWorkspacePath({
                        cwd: options.cwd, inputPath: file.newPath,
                    });
                    if (target && !target.ok) return errorToolResult(target.error, target.error, target.code);

                    // 普通更新读取旧文件；--- /dev/null 表示新增，原文取 ""；不支持删除文件。
                    // 用 applyHunks(original, file.hunks) 得到新文本；先完成内容校验，再写入对应文件。
                    if (!target) throw new Error("Deleting files is not supported");
                    if (targets.has(target.path)) throw new Error(`Duplicate patch target: ${file.newPath}`);
                    if (!source && await Bun.file(target.path).exists()) {
                        throw new Error(`Cannot add an existing file: ${file.newPath}`);
                    }
                    const original = source ? await Bun.file(source.path).text() : "";
                    signal?.throwIfAborted();
                    changes.push({ path: target.path, content: applyHunks(original, file.hunks) });
                    targets.add(target.path);
                }

                // 准备目标父目录，检查 signal，用 Bun.write 写入；记录 changedPaths。
                // 所有文件校验通过后才开始写入；写入阶段的 I/O 失败不具备跨文件回滚能力。
                const changedPaths: string[] = [];
                for (const change of changes) {
                    signal?.throwIfAborted();
                    await mkdir(dirname(change.path), { recursive: true });
                    signal?.throwIfAborted();
                    await Bun.write(change.path, change.content);
                    changedPaths.push(change.path);
                }

                // 返回 okToolResult(summary, { paths: changedPaths })。
                return okToolResult(`Applied patch to ${changedPaths.length} files`, { paths: changedPaths });
            } catch (error) {
                return errorFromException(error, "PATCH_APPLY_FAILED");
            }
        },
    });
}
