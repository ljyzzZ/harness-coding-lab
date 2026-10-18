import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";

// 达到保留上限后继续读到 EOF，避免子进程因 pipe 填满而阻塞。
async function captureOutput(stream: ReadableStream<Uint8Array>, limit: number) {
    // reader 独占读取该流；TextDecoder 默认将输出字节按 UTF-8 解码。
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let truncated = false;
    const retain = (text: string) => {
        // 只保留剩余空间内的文本；空间用完后仍读取，但不再追加内容。
        const remaining = Math.max(0, limit - content.length);
        content += text.slice(0, remaining);
        // ||= 保留已有的 true，只要发生过截断就不会再恢复为 false。
        truncated ||= text.length > remaining;
    };
    try {
        while (true) {
            // await 等待下一块输出，不会空转；done 表示已经读到流末尾（EOF）。
            const { done, value } = await reader.read();
            if (done) break;
            // stream: true 保留解码状态，处理一个 UTF-8 字符被拆到不同块的情况。
            retain(decoder.decode(value, { stream: true }));
        }
        // 输入结束后刷新 decoder，处理内部尚未输出的内容。
        retain(decoder.decode());
        return { content: truncated ? `${content}\n[truncated]` : content, truncated };
    } finally {
        // 成功或抛错都释放读取锁，避免该流一直被这个 reader 占用。
        reader.releaseLock();
    }
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL") {
    try {
        // macOS/Linux 上负 PID 指向整个进程组，包含仍留在组内的命令后代。
        process.kill(-pid, signal);
    } catch (error) {
        // ESRCH 表示进程组已不存在，可忽略；其他错误继续交给调用方处理。
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
}

export function defineBashTool(options: { cwd: string; timeoutMs?: number; maxOutputCharacters?: number }) {
    // 创建工具时保留宿主配置，真正的命令执行发生在 invoke 被调用时。
    return defineTool({
        name: "bash",
        description: "Execute a shell command and capture its output",
        // Registry 用 schema 校验每次调用的参数；实际执行的是 command。
        parameters: z.object({ description: z.string(), command: z.string() }),
        invoke: async (input, signal) => {
            // 调用开始前就已取消时，直接返回，避免启动子进程。
            if (signal?.aborted) return errorToolResult("Command aborted", input.command, "ABORTED");
            try {
                // -c 让 Bash 解析整段命令；spawn 返回进程对象，不等待命令完成。
                const child = Bun.spawn(["bash", "-c", input.command], {
                    // cwd 只设置初始工作目录，命令仍可通过 cd 等方式切换目录。
                    cwd: options.cwd,
                    // 创建独立进程组，组长 PID 用于后续向整组发送终止信号。
                    detached: true,
                    // 不提供交互式输入；通过 pipe 捕获标准输出和标准错误。
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                });
                // stdout、stderr 各自应用此上限，长度按 JS 字符串的 length 计数。
                const limit = options.maxOutputCharacters ?? 12_000;
                // 立即同时读取两条流，暂不 await，避免某条 pipe 填满后卡住子进程。
                const stdoutTask = captureOutput(child.stdout, limit);
                const stderrTask = captureOutput(child.stderr, limit);
                const state: { reason?: "exit" | "timeout" | "abort" } = {};
                // ReturnType 提取定时器句柄类型；Promise<void> 只表示升级终止步骤完成。
                let killTimer: ReturnType<typeof setTimeout> | undefined;
                let escalationTask: Promise<void> | undefined;

                const stop = (reason: "timeout" | "abort") => {
                    // 保留首次记录的停止原因，避免超时和取消重复安排终止操作。
                    if (state.reason !== undefined) return;
                    state.reason = reason;
                    // 先请求退出，给进程自行收尾的机会。
                    signalProcessGroup(child.pid, "SIGTERM");
                    // 约 100ms 后强制终止仍在组内的进程，并用 Promise 跟踪这一步。
                    escalationTask = new Promise((resolve, reject) => {
                        killTimer = setTimeout(() => {
                            try {
                                signalProcessGroup(child.pid, "SIGKILL");
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        }, 100);
                    });
                };
                const onAbort = () => stop("abort");
                // 超时和外部取消共用 stop；定时器到期才调用 callback，不阻塞当前函数。
                const timeoutTimer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 10_000);

                try {
                    // once: true 让监听器触发一次后自动移除。
                    signal?.addEventListener("abort", onAbort, { once: true });
                    // 已取消的 signal 不会补发 abort 事件，注册后再检查一次以免漏掉。
                    if (signal?.aborted) onAbort();
                    // 同时等待退出码和两条流读完；进程退出时可能还有输出尚未读取。
                    const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutTask, stderrTask]);
                    // 等待宽限期结束，收回仍留在进程组内的后代。
                    // 正常完成时任务为 undefined，await 不需要等待任何异步任务。
                    await escalationTask;
                    // ??= 只在原因未设置时记为正常退出，保留已有的 timeout/abort。
                    state.reason ??= "exit";
                    const data = {
                        stdout: stdout.content,
                        stderr: stderr.content,
                        exitCode,
                        truncated: stdout.truncated || stderr.truncated,
                    };
                    // 优先返回取消或超时原因；被终止后的非零退出码不能覆盖这些原因。
                    if (state.reason === "abort")
                        return errorToolResult("Command aborted", input.command, "ABORTED", data);
                    if (state.reason === "timeout")
                        return errorToolResult("Command timed out", input.command, "COMMAND_TIMED_OUT", data);
                    if (exitCode !== 0) return errorToolResult("Command failed", input.command, "COMMAND_FAILED", data);
                    return okToolResult("Command completed", data);
                } catch (error) {
                    // reader 等执行环节失败时，也要收回子进程和两个 pipe。
                    signalProcessGroup(child.pid, "SIGKILL");
                    // 清理时即使某个任务失败，也等其余任务结束，再抛出原始异常。
                    await Promise.allSettled([child.exited, stdoutTask, stderrTask]);
                    throw error;
                } finally {
                    // return 或抛错也会执行，清除定时器和监听器，避免执行结束后再触发。
                    clearTimeout(timeoutTimer);
                    if (killTimer !== undefined) clearTimeout(killTimer);
                    signal?.removeEventListener("abort", onAbort);
                }
            } catch (error) {
                // 内层负责收尾，这里将传播出来的异常转换为统一的工具失败结果。
                return errorFromException(error, "COMMAND_FAILED", { command: input.command });
            }
        },
    });
}
