export type StructuredToolResult<T = unknown> =
    | { ok: true; summary: string; data?: T }
    | {
        ok: false;
        summary: string;
        error: string;
        code?: string;
        details?: Record<string, unknown>;
    };

export function okToolResult<T>(summary: string, data?: T): StructuredToolResult<T> {
    // TODO 1：返回 ok: true、summary 和可选 data。
    // 提示：data 为 undefined 时可以省略字段，但 ok 必须保持 literal true。
    return {
        ok: true,
        summary,
        data,
    };
}

export function errorToolResult(
    summary: string,
    error: string,
    code?: string,
    details?: Record<string, unknown>,
): StructuredToolResult<never> {
    // TODO 2：返回 ok: false、summary、error，以及存在时的 code/details。
    // 提示：这是预期业务失败，不要在最终实现中 throw。
    return {
        ok: false,
        summary,
        error,
        code,
        details
    }
}