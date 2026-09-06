export function serializeToolResult(result: unknown): string {
    const fallback =
        '{"ok":false,"summary":"Tool returned a non-serializable value",' +
        '"error":"Tool result cannot be serialized","code":"NON_SERIALIZABLE_TOOL_RESULT"}';

    if (typeof result === "string") return result;
    try {
        return JSON.stringify(result) ?? fallback;
    } catch {
        return fallback;
    }
}