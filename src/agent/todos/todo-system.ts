import { z } from "zod";

import type { AgentMiddleware } from "@/agent/agent-middleware";
import { defineTool } from "@/foundation/tools";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
    id: string;
    text: string;
    status: TodoStatus;
}
export interface TodoWriteInput {
    merge: boolean;
    items: TodoItem[];
}

const todoItemsSchema = z.array(
    z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed"]),
    }),
);

function formatTodoReminder(items: TodoItem[]): string {
    return `Review unfinished Todos:\n${items.map((item) => `[${item.status}] ${item.text}`).join("\n")}`;
}

export class TodoSystem {
    private readonly _reminderAfterSteps: number;
    private _items: TodoItem[] = [];
    private _step = 0;
    private _lastUpdatedStep = 0;
    private _lastReminderStep = 0;

    constructor(options: { reminderAfterSteps: number }) {
        if (!Number.isSafeInteger(options.reminderAfterSteps) || options.reminderAfterSteps < 1) {
            throw new Error("reminderAfterSteps must be a positive integer");
        }
        this._reminderAfterSteps = options.reminderAfterSteps;
    }

    write(input: TodoWriteInput): void {
        const incoming = todoItemsSchema.parse(input.items);
        if (new Set(incoming.map((item) => item.id)).size !== incoming.length) {
            throw new Error("Duplicate Todo id");
        }
        let next: TodoItem[];
        if (!input.merge) {
            next = incoming; // 全量替换示例：此时仍未修改 store。
        } else {
            // TODO 1：从旧列表构造候选集合，再按 id 更新 incoming 中的条目，得到 next。
            // 已有 id 保持原位置，新 id 追加到末尾；未提及的条目保持不变。
            // 可以使用 Map；只改候选集合，下面的统一校验通过后才提交 this._items。
            const itemsById = new Map<string, TodoItem>(this._items.map((item) => [item.id, item]));

            for (const item of incoming) {
                itemsById.set(item.id, item);
            }

            next = [...itemsById.values()];
        }
        if (next.filter((item) => item.status === "in_progress").length > 1) {
            throw new Error("At most one Todo may be in_progress");
        }
        this._items = next.map((item) => ({ ...item }));
        this._lastUpdatedStep = this._step;
        this._lastReminderStep = this._step;
    }

    snapshot(): TodoItem[] {
        // TodoItem 只有标量字段，复制数组和每个 item 即可隔离可变引用。
        return this._items.map((item) => ({ ...item }));
    }

    reminderForStep(step: number): string | undefined {
        this._step = step;
        const unfinished = this._items.filter((item) => item.status !== "completed");
        // 无未完成项时无需提醒；仍需记录本次 step，供之后的 write 重置计时。
        if (unfinished.length === 0) return;
        // TODO 2：距“最近一次成功写入”和“最近一次提醒”都已达到间隔时才提醒。
        // 未到期返回 undefined，且不能更新 _lastReminderStep。
        // 到期才将 _lastReminderStep 设为 step，并返回 formatTodoReminder(unfinished)。
        if (
            this._step - this._lastUpdatedStep >= this._reminderAfterSteps &&
            this._step - this._lastReminderStep >= this._reminderAfterSteps
        ) {
            this._lastReminderStep = this._step;
            return formatTodoReminder(unfinished);
        }
        return undefined;
    }
}

export function defineTodoIntegration(todos: TodoSystem) {
    // Agent 的 step 每轮从 1 开始；这里独立计数，跨多轮用户输入持续递增。
    let modelStep = 0;
    let reminder: string | undefined;
    const tool = defineTool({
        name: "todo_write",
        description: "Replace or merge the session task list. At most one item may be in_progress.",
        parameters: z.object({
            description: z
                .string()
                .describe("Explain why you want to update Todos. Always place `description` as the first parameter."),
            merge: z.boolean(),
            items: todoItemsSchema,
        }),
        invoke: async (input, signal) => {
            signal?.throwIfAborted();
            todos.write(input);
            return { ok: true, summary: "Todo list updated", data: { items: todos.snapshot() } };
        },
    });
    const middleware: AgentMiddleware = {
        beforeAgentStep: async () => {
            reminder = todos.reminderForStep(++modelStep);
        },
        beforeModel: async ({ modelContext }) => {
            if (reminder) return { prompt: `${modelContext.prompt}\n\n${reminder}` };
        },
    };
    return { tool, middleware };
}
