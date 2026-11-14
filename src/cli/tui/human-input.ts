import type { ApprovalRequest } from "@/coding/permissions/approval-middleware";

export type HumanPrompt =
    | { kind: "approval"; request: ApprovalRequest }
    | { kind: "question"; question: string; choices?: string[] };
export interface PendingHumanInput {
    id: string;
    prompt: HumanPrompt;
}
interface Entry {
    view: PendingHumanInput;
    finish(answer?: string, error?: Error): void;
}

export class HumanInputQueue {
    private readonly _entries: Entry[] = [];
    private readonly _listeners = new Set<() => void>();

    get current(): PendingHumanInput | undefined {
        return this._entries[0]?.view;
    }

    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    request(prompt: HumanPrompt, signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        if (this._entries.length >= 16) return Promise.reject(new Error("Human input queue is full"));
        return new Promise((resolve, reject) => {
            let settled = false;
            const onAbort = () => entry.finish(undefined, new DOMException("Input cancelled", "AbortError"));
            const entry: Entry = {
                view: { id: crypto.randomUUID(), prompt },
                finish: (answer, error) => {
                    if (settled) return;
                    settled = true;
                    signal?.removeEventListener("abort", onAbort);
                    this._entries.splice(this._entries.indexOf(entry), 1);
                    if (error) reject(error);
                    else resolve(answer!);
                    this._emit();
                },
            };
            this._entries.push(entry);
            signal?.addEventListener("abort", onAbort, { once: true });
            this._emit();
            if (signal?.aborted) onAbort();
        });
    }

    answer(id: string, answer: string): boolean {
        const entry = this._entries[0];
        if (!entry || entry.view.id !== id) return false; // 拒绝迟到的旧界面答案。
        entry.finish(answer);
        return true;
    }

    cancelAll(): void {
        for (const entry of [...this._entries]) {
            entry.finish(undefined, new DOMException("Input cancelled", "AbortError"));
        }
    }

    private _emit(): void {
        this._listeners.forEach((listener) => listener());
    }
}
