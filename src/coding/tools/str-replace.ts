import { stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineStrReplaceTool(options: { cwd: string }) {
    return defineTool({
        name: "str_replace",
        description: "Replace exactly one literal occurrence",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
            oldText: z.string().min(1),
            newText: z.string(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({
                    cwd: options.cwd,
                    inputPath: input.path,
                });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：stat 确认普通文件（否则 NOT_A_FILE），再用 Bun.file(resolved.path).text() 读取 original。
                if (!(await stat(resolved.path)).isFile()) {
                    return errorToolResult("Not a file", input.path, "NOT_A_FILE");
                }
                const original = await Bun.file(resolved.path).text();
                // TODO 2：matches = original.split(input.oldText).length - 1。
                // 0 次返回 PATTERN_NOT_FOUND，多次返回 AMBIGUOUS_REPLACEMENT，均不能写文件。
                const matches = original.split(input.oldText).length - 1;
                if (matches === 0) {
                    return errorToolResult("Pattern not found", input.path, "PATTERN_NOT_FOUND");
                } else if (matches > 1) {
                    return errorToolResult("Ambiguous replacement", input.path, "AMBIGUOUS_REPLACEMENT");
                }
                // TODO 3：updated = original.replace(input.oldText, () => input.newText)。
                // callback 保证 $&、$1 等被当作普通文本；不要直接把 newText 当替换表达式。
                const updated = original.replace(input.oldText, () => input.newText);
                // TODO 4：写入前检查 signal，Bun.write(resolved.path, updated)。
                // 返回 okToolResult(summary, { path: resolved.path, replacements: 1 })。
                signal?.throwIfAborted();
                await Bun.write(resolved.path, updated);
                return okToolResult(`Replace in ${input.path}`, { path: resolved.path, replacements: 1 });
            } catch (error) {
                return errorFromException(error, "STR_REPLACE_FAILED", { path: input.path });
            }
        },
    });
}
