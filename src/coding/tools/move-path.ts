import { rename, stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineMovePathTool(options: { cwd: string }) {
    return defineTool({
        name: "move_path",
        description: "Move or rename a file or directory inside the workspace",
        parameters: z.object({ description: z.string(), from: z.string(), to: z.string() }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const source = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.from });
                if (!source.ok) return errorToolResult(source.error, source.error, source.code);
                const target = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.to });
                if (!target.ok) return errorToolResult(target.error, target.error, target.code);

                // TODO 1：await stat(source.path) 确认源存在；ENOENT 由 catch 转为 FILE_NOT_FOUND。
                await stat(source.path);

                // TODO 2：移动前检查 signal；await rename(source.path, target.path)。
                signal?.throwIfAborted();
                await rename(source.path, target.path);
                // TODO 3：返回 okToolResult(summary, { from: source.path, to: target.path })。
                return okToolResult("Move path success", { from: source.path, to: target.path });
            } catch (error) {
                return errorFromException(error, "MOVE_FAILED", { from: input.from, to: input.to });
            }
        },
    });
}
