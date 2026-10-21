import { describe, expect, test } from "bun:test";

import { TodoSystem, defineTodoIntegration } from "../todo-system";

describe("TodoSystem", () => {
    test("replaces all items when merge is false", () => {
        const todos = new TodoSystem({ reminderAfterSteps: 2 });
        todos.write({
            merge: false,
            items: [
                { id: "a", text: "inspect", status: "completed" },
                { id: "b", text: "edit", status: "in_progress" },
            ],
        });

        expect(todos.snapshot()).toHaveLength(2);
    });

    test("merges by id and rejects two in-progress items", () => {
        const todos = new TodoSystem({ reminderAfterSteps: 2 });
        todos.write({
            merge: false,
            items: [{ id: "a", text: "inspect", status: "in_progress" }],
        });
        todos.write({
            merge: true,
            items: [{ id: "a", text: "inspect", status: "completed" }],
        });
        expect(todos.snapshot()[0]?.status).toBe("completed");

        expect(() =>
            todos.write({
                merge: false,
                items: [
                    { id: "a", text: "one", status: "in_progress" },
                    { id: "b", text: "two", status: "in_progress" },
                ],
            }),
        ).toThrow("in_progress");
    });

    test("reminds only after the configured number of untouched steps", () => {
        const todos = new TodoSystem({ reminderAfterSteps: 2 });
        todos.write({
            merge: false,
            items: [{ id: "a", text: "inspect", status: "pending" }],
        });
        expect(todos.reminderForStep(1)).toBeUndefined();
        expect(todos.reminderForStep(2)).toContain("inspect");
        expect(todos.reminderForStep(2)).toBeUndefined();
        expect(todos.reminderForStep(3)).toBeUndefined();
        todos.write({ merge: true, items: [{ id: "a", text: "inspect", status: "pending" }] });
        expect(todos.reminderForStep(4)).toBeUndefined();
        expect(todos.reminderForStep(5)).toContain("inspect");
    });

    test("commits merges atomically and isolates input and snapshot references", () => {
        const todos = new TodoSystem({ reminderAfterSteps: 2 });
        const items = [{ id: "a", text: "inspect", status: "in_progress" as const }];
        todos.write({ merge: false, items });
        items[0]!.text = "mutated input";
        const snapshot = todos.snapshot();
        snapshot[0]!.text = "mutated snapshot";
        expect(todos.snapshot()[0]!.text).toBe("inspect");
        expect(() => todos.write({ merge: true, items: [{ id: "b", text: "edit", status: "in_progress" }] })).toThrow(
            "in_progress",
        );
        expect(todos.snapshot()).toEqual([{ id: "a", text: "inspect", status: "in_progress" }]);
        todos.write({
            merge: true,
            items: [
                { id: "a", text: "inspect", status: "completed" },
                { id: "b", text: "edit", status: "in_progress" },
            ],
        });
        expect(todos.snapshot().map((item) => item.id)).toEqual(["a", "b"]);
    });

    test("does not reset the reminder on a rejected write and stops after completion", () => {
        const todos = new TodoSystem({ reminderAfterSteps: 2 });
        todos.write({ merge: false, items: [{ id: "a", text: "inspect", status: "pending" }] });
        expect(todos.reminderForStep(2)).toContain("inspect");
        expect(todos.reminderForStep(3)).toBeUndefined();
        expect(() =>
            todos.write({
                merge: false,
                items: [
                    { id: "a", text: "inspect", status: "in_progress" },
                    { id: "b", text: "edit", status: "in_progress" },
                ],
            }),
        ).toThrow("in_progress");
        expect(todos.reminderForStep(4)).toContain("inspect");
        todos.write({ merge: true, items: [{ id: "a", text: "inspect", status: "completed" }] });
        expect(todos.reminderForStep(10)).toBeUndefined();
    });

    test("connects the Tool and reminder to one store across user runs", async () => {
        const todos = new TodoSystem({ reminderAfterSteps: 2 });
        const { tool, middleware } = defineTodoIntegration(todos);
        const agentContext = { prompt: "base", messages: [] };
        await tool.invoke({
            description: "plan work",
            merge: false,
            items: [{ id: "a", text: "inspect", status: "pending" }],
        });
        await middleware.beforeAgentStep!({ agentContext, step: 1 });
        expect(await middleware.beforeModel!({ agentContext, modelContext: { ...agentContext } })).toBeUndefined();
        // 第二轮用户输入的 Agent step 又是 1，Todo 的内部计数仍继续递增。
        await middleware.beforeAgentStep!({ agentContext, step: 1 });
        const update = await middleware.beforeModel!({ agentContext, modelContext: { ...agentContext } });
        expect(update?.prompt).toContain("inspect");
        expect(agentContext).toEqual({ prompt: "base", messages: [] });
    });
});
