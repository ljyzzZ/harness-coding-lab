import { mkdir } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineMkdirTool(options: { cwd: string }) {
    return defineTool({
        name: "mkdir",
        description: "Create a directory inside the workspace",
        parameters: z.object({
            description: z.string(),
            path: z.string(),
            recursive: z.boolean().optional(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
                if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

                // TODO 1：写入前再检查 signal；await mkdir(resolved.path, { recursive: input.recursive ?? true })。
                signal?.throwIfAborted();
                await mkdir(resolved.path, { recursive: input.recursive ?? true });
                // TODO 2：返回 okToolResult(summary, { path: resolved.path })。
                return okToolResult("mkdir exec success", { path: resolved.path });
            } catch (error) {
                return errorFromException(error, "MKDIR_FAILED", { path: input.path });
            }
        },
    });
}
