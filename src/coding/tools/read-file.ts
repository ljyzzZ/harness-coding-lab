import { stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineReadFileTool(options: { cwd: string; maxCharacters?: number }) {
    // 工具通过闭包保留宿主指定的 workspace 和输出长度限制。
    return defineTool({
        name: "read_file",
        description: "Read a UTF-8 text file or a bounded line range",
        // Registry 会用这个 schema 校验参数；对外的行号从 1 开始。
        parameters: z.object({
            description: z.string(),
            path: z.string(),
            startLine: z.number().int().positive().optional(),
            endLine: z.number().int().positive().optional(),
        }),
        invoke: async (input, signal) => {
            try {
                signal?.throwIfAborted();
                // 解析真实路径并检查 workspace 边界，后续只使用校验后的路径。
                const resolved = await resolveWorkspacePath({
                    cwd: options.cwd,
                    inputPath: input.path,
                });
                if (!resolved.ok)
                    return errorToolResult(resolved.error, resolved.error, resolved.code);
                // stat 提供文件类型信息，isFile() 排除目录等非普通文件。
                if (!(await stat(resolved.path)).isFile()) {
                    return errorToolResult("Not a file", input.path, "NOT_A_FILE");
                }

                const text = await Bun.file(resolved.path).text();
                const lines = text === "" ? [] : text.split("\n");
                // 末尾换行会让 split 多出一个空元素，不将它计为额外的一行。
                if (text.endsWith("\n")) lines.pop();
                let content = text;
                const { startLine, endLine } = input;

                if (startLine !== undefined || endLine !== undefined) {
                    // 指定行范围时，起止行必须成对提供、顺序正确且不超出文件行数。
                    if (startLine === undefined || endLine === undefined || startLine > endLine) {
                        return errorToolResult(
                            "Invalid line range",
                            input.path,
                            "INVALID_LINE_RANGE",
                        );
                    }
                    if (startLine > lines.length) {
                        return errorToolResult(
                            "Start line is out of range",
                            input.path,
                            "START_LINE_OUT_OF_RANGE",
                        );
                    }
                    if (endLine > lines.length) {
                        return errorToolResult(
                            "End line is out of range",
                            input.path,
                            "INVALID_LINE_RANGE",
                        );
                    }
                    // slice 从 0 开始且不包含右端点；例如第 2～4 行对应 slice(1, 4)。
                    // 为选中的文本加上原始行号，方便模型定位后续修改。
                    content = lines
                        .slice(startLine - 1, endLine)
                        .map((line, index) => `${startLine + index}: ${line}`)
                        .join("\n");
                }

                // 文件读取期间也可能收到取消请求，因此返回前再检查一次。
                signal?.throwIfAborted();
                // 限制返回给模型的文本长度；此时文件已完整读入，限制的是输出量。
                const limit = options.maxCharacters ?? 12_000;
                const truncated = content.length > limit;
                if (truncated) content = `${content.slice(0, limit)}\n[truncated]`;
                return okToolResult(`Read ${input.path}`, {
                    path: resolved.path,
                    content,
                    truncated,
                });
            } catch (error) {
                // 将文件系统和取消异常转换为统一的工具失败结果。
                return errorFromException(error, "READ_FAILED", { path: input.path });
            }
        },
    });
}
