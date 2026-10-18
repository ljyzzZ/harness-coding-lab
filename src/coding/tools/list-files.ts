import { readdir, stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineListFilesTool(options: { cwd: string; maxResults?: number }) {
    return defineTool({
        name: "list_files",
        description: "List the immediate entries in a directory",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：stat 后确认是目录；否则用 errorToolResult(summary, error, "NOT_A_DIRECTORY") 返回。
                if (!(await stat(resolved.path)).isDirectory()) {
                    return errorToolResult("Not a directory", input.path, "NOT_A_DIRECTORY");
                }
                // TODO 2：await readdir(resolved.path) 得到直接子项名称，不需要递归；先 sort()。
                const names = await readdir(resolved.path);
                signal?.throwIfAborted();
                names.sort();
                // TODO 3：limit = options.maxResults ?? 200；entries = names.slice(0, limit)。
                const limit = options.maxResults ?? 200;
                const entries = names.slice(0, limit);
                // TODO 4：返回 { entries, truncated: names.length > limit }，而非只返回 ok。
                return okToolResult("List files success", { entries, truncated: names.length > limit });
            } catch (error) {
                return errorFromException(error, "LIST_FILES_FAILED", { path: input.path });
            }
        },
    });
}
