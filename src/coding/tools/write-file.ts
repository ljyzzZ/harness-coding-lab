import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineWriteFileTool(options: { cwd: string }) {
    return defineTool({
        name: "write_file",
        description: "Create or overwrite a UTF-8 text file",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
            content: z.string(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：await mkdir(dirname(resolved.path), { recursive: true }) 准备父目录。
                signal?.throwIfAborted();
                await mkdir(dirname(resolved.path), { recursive: true });
                // TODO 2：写入前再检查 signal；await Bun.write(resolved.path, input.content)。
                signal?.throwIfAborted();
                await Bun.write(resolved.path, input.content);
                // TODO 3：返回 okToolResult(summary, { path: resolved.path })。
                // 此 Tool 明确允许覆盖已有文件；修改现有片段时使用 str_replace。
                return okToolResult("Write file success", { path: resolved.path });
            } catch (error) {
                return errorFromException(error, "WRITE_FILE_FAILED", { path: input.path });
            }
        },
    });
}
