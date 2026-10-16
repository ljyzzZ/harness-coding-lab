import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PathValidationResult =
    | { ok: true; path: string }
    | { ok: false; code: "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE"; error: string };

export async function resolveWorkspacePath(options: {
    cwd: string;
    inputPath: string;
}): Promise<PathValidationResult> {
    try {
        // realpath 解析 workspace 的符号链接；resolve 只拼接路径，不要求目标存在。
        const realCwd = await realpath(options.cwd);
        const absolutePath = resolve(options.cwd, options.inputPath);
        let ancestor = absolutePath;
        const missingParts: string[] = [];

        // 目标可能尚未创建，逐级向上查找，直到找到存在的路径或遇到无法处理的错误。
        while (true) {
            try {
                // lstat 检查路径项本身，末尾是符号链接时也不跟随它；成功后退出循环。
                await lstat(ancestor);
                break;
            } catch (error) {
                // 只有“路径不存在”才向上找，其他 I/O 错误交给外层 catch。
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                    throw error;
                // dirname 去掉最后一个路径段；根目录的父路径还是它自己，不能继续上移。
                const parent = dirname(ancestor);
                if (parent === ancestor) throw error;

                // basename 取最后一段；unshift 放到数组头部，保持后续拼接时的父到子顺序。
                missingParts.unshift(basename(ancestor));
                ancestor = parent;
            }
        }

        // 解析找到的路径实际指向的位置，避免 workspace 内的链接指向外部。
        const realAncestor = await realpath(ancestor);
        // relative 计算从 workspace 到真实路径的路线，如 "src"、"" 或 "../outside"。
        const relativePath = relative(realCwd, realAncestor);

        // 需要先向上走就表示越界；Windows 跨盘符时结果可能是绝对路径，也应拒绝。
        // 空字符串表示 workspace 本身，允许通过；sep 是平台的路径分隔符。
        if (
            relativePath === ".." ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)
        ) {
            return {
                ok: false,
                code: "PATH_OUTSIDE_WORKSPACE",
                error: "Path can't be out of cwd.",
            };
        }

        // 在真实路径上拼回尚不存在的部分，保留符号链接解析后的结果。
        return {
            ok: true,
            path: resolve(realAncestor, ...missingParts),
        };
    } catch (error) {
        return {
            ok: false,
            code: "INVALID_PATH",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
