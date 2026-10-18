import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineGlobSearchTool(options: { cwd: string; maxResults?: number }) {
    return defineTool({
        name: "glob_search",
        description: "Find paths matching a glob pattern",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
            pattern: z.string(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：确认 resolved.path 是目录；否则返回 NOT_A_DIRECTORY。
                if (!(await stat(resolved.path)).isDirectory()) {
                    return errorToolResult("Not a directory", input.path, "NOT_A_DIRECTORY");
                }
                // TODO 2：new Bun.Glob(input.pattern).scan({ cwd: resolved.path, onlyFiles: true, followSymlinks: false })。
                // 用 for await 消费结果；每个候选以 resolved.path 为基准再次 resolveWorkspacePath，跳过越界项。
                // TODO 3：realCwd = await realpath(options.cwd)，用 relative(realCwd, candidate.path)
                // 将通过校验的路径转换为相对 workspace 的路径；排序后再截取 maxResults ?? 200。
                const matches = new Bun.Glob(input.pattern).scan({
                    cwd: resolved.path,
                    onlyFiles: true,
                    followSymlinks: false,
                });

                const resultPaths: string[] = [];
                const realCwd = await realpath(options.cwd);

                for await (const path of matches) {
                    // scan() 返回异步迭代器，不是 string[]， 因此用 for await 逐个取结果
                    // path 可能依次是 "index.ts"、"utils/helper.ts"
                    const candidate = await resolveWorkspacePath({ cwd: resolved.path, inputPath: path });
                    if (!candidate.ok) continue;

                    const relativePath = relative(realCwd, candidate.path);
                    resultPaths.push(relativePath);
                }

                resultPaths.sort();

                const limit = options.maxResults ?? 200;
                const truncated = resultPaths.length > limit;
                const paths = resultPaths.slice(0, limit);

                // TODO 4：返回 { paths, truncated }；truncated 表示匹配总数超过上限。
                return okToolResult(`Found ${paths.length} paths`, {
                    paths,
                    truncated,
                });
            } catch (error) {
                return errorFromException(error, "GLOB_SEARCH_FAILED", { path: input.path });
            }
        },
    });
}
