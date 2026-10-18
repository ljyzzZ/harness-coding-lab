import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

import { regex, z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineGrepSearchTool(options: { cwd: string; maxResults?: number }) {
    return defineTool({
        name: "grep_search",
        description: "Search UTF-8 text files by text or regex",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
            pattern: z.string(),
            regex: z.boolean().optional(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：确认是目录；regex 为 true 时构造 new RegExp(input.pattern)，否则用 includes。
                if (!(await stat(resolved.path)).isDirectory()) {
                    return errorToolResult("Not a directory", input.path, "NOT_A_DIRECTORY");
                }
                const regexp = input.regex ? new RegExp(input.pattern) : undefined;
                const isMatch = (text: string): boolean => (regexp ? regexp.test(text) : text.includes(input.pattern));

                // TODO 2：用 Bun.Glob("**/*") 枚举文件（scan 选项同 glob_search），按路径排序。
                // 每个候选再次验证 workspace 边界后，才用 Bun.file(candidate.path).text() 读取。
                const files: string[] = [];

                for await (const path of new Bun.Glob("**/*").scan({
                    cwd: resolved.path,
                    onlyFiles: true,
                    followSymlinks: false,
                })) {
                    signal?.throwIfAborted();
                    files.push(path);
                }
                files.sort();

                const matches: { path: string; line: number; text: string }[] = []; // 结果数组
                const realCwd = await realpath(options.cwd);
                const limit = options.maxResults ?? 200;

                for (const filePath of files) {
                    signal?.throwIfAborted();
                    const candidate = await resolveWorkspacePath({ cwd: resolved.path, inputPath: filePath });
                    if (!candidate.ok) continue;

                    // TODO 3：逐行匹配；每条结果为 { path: relative(realCwd, candidate.path), line: index + 1, text }。
                    // realCwd = await realpath(options.cwd)；末尾换行产生的空项不计作一行。
                    const content = await Bun.file(candidate.path).text();
                    signal?.throwIfAborted();
                    const lines = content === "" ? [] : content.split(/\r?\n/);
                    if (content.endsWith("\n")) lines.pop();

                    const workspacePath = relative(realCwd, candidate.path);
                    for (const [index, text] of lines.entries()) {
                        signal?.throwIfAborted();
                        if (!isMatch(text)) continue;

                        // TODO 4：保留 maxResults ?? 200 条；再找到一条时 truncated=true，可以结束搜索。
                        // 返回 { matches, truncated }；没有匹配是成功，matches 为 []。
                        if (matches.length >= limit) {
                            return okToolResult(`Found ${matches.length} matches`, {
                                matches,
                                truncated: true,
                            });
                        }

                        matches.push({
                            path: workspacePath,
                            line: index + 1,
                            text,
                        });
                    }
                }

                return okToolResult(`Found ${matches.length} matches`, {
                    matches,
                    truncated: false,
                });
            } catch (error) {
                return errorFromException(error, "GREP_SEARCH_FAILED", { path: input.path });
            }
        },
    });
}
