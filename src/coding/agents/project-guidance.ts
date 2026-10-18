import { join } from "node:path";

export async function readProjectGuidance(options: {
    cwd: string;
    maxCharacters?: number;
    onWarning?: (message: string) => void;
}): Promise<string> {
    const path = join(options.cwd, "AGENTS.md");
    const limit = options.maxCharacters ?? 12_000;
    if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error("maxGuidanceCharacters must be a non-negative integer");
    }
    let content: string;
    try {
        content = await Bun.file(path).text();
    } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return "";
        throw error; // 无权限或 I/O 故障不是“文件不存在”。
    }
    if (content.length > limit) options.onWarning?.(`Truncated AGENTS.md: ${path} to ${limit} characters`);
    return content.slice(0, limit);
}
