import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { ApprovalPersistence } from "./approval-middleware";

const approvalFileSchema = z.object({
    version: z.literal(1),
    projects: z.record(z.string(), z.array(z.string())),
});
type ApprovalFile = z.infer<typeof approvalFileSchema>;

export function defineApprovalPersistence(options: { path: string }): ApprovalPersistence {
    let tail = Promise.resolve();

    async function read(): Promise<ApprovalFile> {
        try {
            return approvalFileSchema.parse(await Bun.file(options.path).json());
        } catch (error) {
            if ((error as { code?: string }).code === "ENOENT") return { version: 1, projects: {} };
            throw error;
        }
    }

    async function save(value: ApprovalFile): Promise<void> {
        await mkdir(dirname(options.path), { recursive: true });
        const temporary = `${options.path}.${crypto.randomUUID()}.tmp`;
        try {
            await Bun.write(temporary, JSON.stringify(value, null, 2));
            await rename(temporary, options.path);
        } finally {
            await rm(temporary, { force: true }).catch(() => {});
        }
    }

    return {
        has: async (projectId, toolName) => {
            await tail; // 等待当前实例已经提交的写请求，避免读到上一份状态。
            return (await read()).projects[projectId]?.includes(toolName) ?? false;
        },
        add: (projectId, toolName) => {
            const operation = tail.then(async () => {
                const current = await read();
                // TODO 1：从 current.projects[projectId] ?? [] 构造 Set，add(toolName)。
                // current.projects[projectId] = [...allowed]；然后 await save(current)。
                // read 返回独立对象；只有 rename 成功才提交磁盘状态，不需要另设缓存。
                const allowed = new Set(current.projects[projectId] ?? []);
                allowed.add(toolName);
                current.projects[projectId] = [...allowed];
                await save(current);
            });
            // 调用方仍收到 operation 的失败；队列自身恢复，下一次 add 可以继续。
            tail = operation.catch(() => {});
            return operation;
        },
    };
}
