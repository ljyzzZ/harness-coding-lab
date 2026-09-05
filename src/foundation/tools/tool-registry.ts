import { input } from "zod";
import type { Tool } from "./function-tool";

export type ToolExecutionErrorCode =
    | "TOOL_NOT_FOUND"
    | "INVALID_TOOL_INPUT"
    | "ABORTED"
    | "TOOL_EXECUTION_FAILED";

export type ToolExecutionResult =
    | { ok: true; toolName: string; value: unknown }
    | {
        ok: false;
        toolName: string;
        code: ToolExecutionErrorCode;
        error: string;
    };

export class ToolRegistry {
    private readonly _tools = new Map<string, Tool>();

    constructor({ tools }: { tools: Tool[] }) {
        // 标准实现示例：构造阶段固定注册表，并立即拒绝重复 name。
        for (const tool of tools) {
            if (this._tools.has(tool.name)) {
                throw new Error(`Duplicate tool name: ${tool.name}`);
            }
            this._tools.set(tool.name, tool);
        }
    }

    list(): Tool[] {
        // TODO 1：读取 this._tools.values() 并返回新的数组。
        // Map 会保持插入顺序，因此不需要额外排序；不要把内部 Map 暴露给调用方。
        return [...this._tools.values()];
    }

    async invoke(options: {
        name: string;
        input: unknown;
        signal?: AbortSignal;
    }): Promise<ToolExecutionResult> {
        // TODO 2：用 options.name 查找 Tool。未注册时立即返回 TOOL_NOT_FOUND；
        // toolName 保留调用方传入的名称，便于 trace 定位模型实际请求了什么。
        const tool = this._tools.get(options.name);

        if (!tool) {
            return {
                ok: false,
                toolName: options.name,
                code: "TOOL_NOT_FOUND",
                error: `Unknown tool: ${options.name}`,
            };
        }

        // TODO 3：对 options.input 调用 tool.parameters.safeParse()。
        // 校验失败时返回 INVALID_TOOL_INPUT，且不得进入 tool.invoke()。
        const parseResult = tool?.parameters.safeParse(options.input);
        if (!parseResult?.success) {
            return {
                ok: false,
                toolName: options.name,
                code: "INVALID_TOOL_INPUT",
                error: parseResult?.error.message ?? `Invalid tool input: ${options.name}`
            }
        }
        // TODO 4：调用 Tool 前检查 options.signal。已经中止时返回 ABORTED，
        // 确保具有副作用的实现不会在取消后才开始执行。
        if (options.signal?.aborted) {
            return {
                ok: false,
                toolName: tool.name,
                code: "ABORTED",
                error: "Tool execution was aborted",
            };
        }

        // TODO 5：把 parsed.data 而不是原始 input 传给 tool.invoke()，同时继续传递 signal；
        // 成功后返回 { ok: true, toolName: tool.name, value }。
        // TODO 6：用 try/catch 包围真实调用。signal 已中止或捕获到 AbortError 时返回
        // ABORTED；其余异常转换为 TOOL_EXECUTION_FAILED，并保留可读的错误消息。
        // 单个 Tool 的异常不能逃出 Registry 并终止整个 Agent loop。
        try {
            const value = await tool.invoke(
                parseResult.data,
                options.signal
            );
            return { ok: true, toolName: tool.name, value };
        } catch (error: unknown) {
            const isAbortError = error instanceof Error && error.name === "AbortError";
            if (options.signal?.aborted || isAbortError) {
                return {
                    ok: false,
                    toolName: tool.name,
                    code: "ABORTED",
                    error: "Tool execution was aborted",
                }
            }

            return {
                ok: false,
                toolName: tool.name,
                code: "TOOL_EXECUTION_FAILED",
                error: error instanceof Error ? error.message : String(error),
            }
        }
    }
}