export { errorToolResult, okToolResult } from "@/foundation/tools";

export function errorFromException(
    error: unknown,
    fallbackCode: string,
    details?: Record<string, unknown>,
) {
    const message = error instanceof Error ? error.message : String(error);
    // 保留取消、文件不存在这两类可识别错误；其他异常使用工具传入的兜底错误码。
    const code =
        error instanceof Error && error.name === "AbortError"
            ? "ABORTED"
            : typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              ? "FILE_NOT_FOUND"
              : fallbackCode;
    // as const 保留 ok 的字面量 false 类型，便于调用方按成功/失败分支收窄类型。
    return { ok: false as const, summary: message, error: message, code, details };
}
