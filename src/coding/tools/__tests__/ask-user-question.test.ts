import { describe, expect, test } from "bun:test";

import { defineAskUserQuestionTool } from "../ask-user-question";

describe("ask_user_question", () => {
    test("keeps concurrent answers associated with their invocation", async () => {
        const tool = defineAskUserQuestionTool({
            handler: async ({ question }) => {
                await Bun.sleep(question === "slow" ? 20 : 1);
                return { answer: `answer:${question}` };
            },
        });

        const [slow, fast] = await Promise.all([
            tool.invoke({ description: "ask slow", question: "slow" }),
            tool.invoke({ description: "ask fast", question: "fast" }),
        ]);

        expect(slow).toEqual({ answer: "answer:slow" });
        expect(fast).toEqual({ answer: "answer:fast" });
    });

    test("does not invoke the handler when already aborted", async () => {
        let calls = 0;
        const tool = defineAskUserQuestionTool({
            handler: async () => {
                calls++;
                return { answer: "unused" };
            },
        });
        const controller = new AbortController();
        controller.abort();
        await expect(
            tool.invoke({ description: "ask", question: "continue?" }, controller.signal),
        ).rejects.toHaveProperty("name", "AbortError");
        expect(calls).toBe(0);
    });

    test("forwards the signal and rejects an answer returned after cancellation", async () => {
        const controller = new AbortController();
        const tool = defineAskUserQuestionTool({
            handler: async ({ question, choices, signal }) => {
                expect(question).toBe("continue?");
                expect(choices).toEqual(["yes", "no"]);
                expect(signal).toBe(controller.signal);
                controller.abort();
                return { answer: "late answer" };
            },
        });
        await expect(
            tool.invoke({ description: "ask", question: "continue?", choices: ["yes", "no"] }, controller.signal),
        ).rejects.toHaveProperty("name", "AbortError");
    });
});
