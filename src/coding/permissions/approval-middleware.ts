import type { AgentMiddleware } from "@/agent/agent-middleware";
import type { ToolUseContent } from "@/foundation/messages";
import type { ApprovalDecision } from "@/foundation/permissions/approval-decision";

export type { ApprovalDecision } from "@/foundation/permissions/approval-decision";

const TOOLS_REQUIRING_APPROVAL = new Set(["bash", "write_file", "str_replace", "apply_patch", "mkdir", "move_path"]);
export interface ApprovalRequest {
    id: string;
    toolName: string;
    toolUse: ToolUseContent;
}
export interface ApprovalPersistence {
    has(projectId: string, toolName: string): Promise<boolean>;
    add(projectId: string, toolName: string): Promise<void>;
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(signal.reason);
        };
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        // 即使取消先发生，也观察原 promise 的 rejection，避免 unhandled rejection。
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

export function defineApprovalMiddleware(options: {
    projectId: string;
    maxQueueLength: number;
    requestDecision(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
    persistence?: ApprovalPersistence;
    onWarning?: (message: string) => void;
}): AgentMiddleware {
    if (!Number.isSafeInteger(options.maxQueueLength) || options.maxQueueLength < 1) {
        throw new Error("maxQueueLength must be a positive integer");
    }
    let tail = Promise.resolve();
    let pending = 0;
    const warn = options.onWarning ?? ((message: string) => console.warn(message));
    const deny = (code: string, error: string) => ({
        __skip: true as const,
        result: { ok: false, summary: error, error, code },
    });

    return {
        beforeToolUse: async ({ toolUse, signal }) => {
            signal?.throwIfAborted();
            if (!TOOLS_REQUIRING_APPROVAL.has(toolUse.name)) return;
            if (pending >= options.maxQueueLength) {
                return deny("APPROVAL_QUEUE_FULL", "Approval queue is full");
            }
            // 必须在第一个 await 前占位，否则并发调用可能同时越过容量检查。
            pending++;
            const previous = tail;
            let release!: () => void;
            const done = new Promise<void>((resolve) => {
                release = resolve;
            });
            // 中间请求取消时，后继仍要等 previous；不能提前越过当前展示者。
            tail = previous.then(() => done);
            try {
                await waitWithSignal(previous, signal);
                signal?.throwIfAborted();
                try {
                    if (
                        options.persistence &&
                        (await waitWithSignal(options.persistence.has(options.projectId, toolUse.name), signal))
                    )
                        return;
                } catch (error) {
                    signal?.throwIfAborted();
                    warn(`Cannot read approval persistence: ${String(error)}`);
                    // 无法读取 allowlist 时仍需询问，不默认放行。
                }
                signal?.throwIfAborted();
                const decision = await waitWithSignal(
                    options.requestDecision(
                        {
                            id: crypto.randomUUID(),
                            toolName: toolUse.name,
                            toolUse,
                        },
                        signal,
                    ),
                    signal,
                );
                signal?.throwIfAborted();
                if (decision === "deny") return deny("USER_DENIED", "User denied this tool call");

                // TODO 1：allow_once 直接 return；不写入 persistence。
                if (decision === "allow_once") return;
                // TODO 2：allow_always_project 时用 waitWithSignal 等待 persistence.add(projectId, toolUse.name)。
                // 将 add 放在独立 try/catch 中；失败调用 warn，但仍允许本次动作。
                // 写完后再次检查 signal，再 return；没有 persistence 时也只允许本次动作并 warning。
                // 其他值（例如损坏的 UI 回答）返回 deny("APPROVAL_FAILED", "Invalid approval decision")。
                if (decision === "allow_always_project") {
                    if (options.persistence) {
                        try {
                            await waitWithSignal(options.persistence.add(options.projectId, toolUse.name), signal);
                        } catch (error) {
                            signal?.throwIfAborted();
                            warn(`Cannot persist approval: ${String(error)}`);
                        }
                    } else {
                        warn("Approval persistence is unavailable; allowing this tool call only");
                    }

                    signal?.throwIfAborted();
                    return;
                }

                // TypeScript 类型不能保证外部输入在运行时一定合法。
                return deny("APPROVAL_FAILED", "Invalid approval decision");
            } catch (error) {
                signal?.throwIfAborted();
                warn(`Approval failed: ${String(error)}`);
                return deny("APPROVAL_FAILED", "Could not obtain approval");
            } finally {
                pending--;
                release(); // 允许、拒绝、异常和取消都必须释放队列。
            }
        },
    };
}
