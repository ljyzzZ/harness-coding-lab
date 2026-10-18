import { stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineFileInfoTool(options: { cwd: string }) {
    return defineTool({
        name: "file_info",
        description: "Inspect a file or directory",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：const info = await stat(resolved.path)。不存在由 catch 返回 FILE_NOT_FOUND。
                const info = await stat(resolved.path);
                if (!info) {
                    throw new Error("FILE_NOT_FOUND");
                }
                // TODO 2：用 info.isFile()/isDirectory() 得到 type: "file" | "directory"。
                const type = info.isFile() ? "file" : "directory";
                // TODO 3：返回 okToolResult(summary, { path: resolved.path, type, size: info.size })。
                return okToolResult("Get file info", { path: resolved.path, type, size: info.size });
            } catch (error) {
                return errorFromException(error, "FILE_INFO_FAILED", { path: input.path });
            }
        },
    });
}
