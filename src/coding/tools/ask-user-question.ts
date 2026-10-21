import { z } from "zod";

import { defineTool } from "@/foundation/tools";

export type AskUserQuestionHandler = (params: {
    question: string;
    choices?: string[];
    signal?: AbortSignal;
}) => Promise<{ answer: string }>;

export function defineAskUserQuestionTool(options: { handler: AskUserQuestionHandler }) {
    return defineTool({
        name: "ask_user_question",
        description: "Ask the user for missing information needed to continue.",
        parameters: z.object({
            description: z
                .string()
                .describe("Explain why you want to ask the user. Always place `description` as the first parameter."),
            question: z.string().min(1),
            choices: z.array(z.string().min(1)).min(1).optional(),
        }),
        invoke: async ({ question, choices }, signal): Promise<{ answer: string }> => {
            signal?.throwIfAborted();
            // TODO：await 当前调用的 handler，透传 question、choices、signal。
            // 等待期间可能取消，因此取得答案后再次检查 signal，再原样返回结果。
            // 不捕获并吞掉 handler 的异常；也不要用共享变量保存各次调用的答案。
            const answer = await options.handler({ question: question, choices: choices, signal: signal });
            signal?.throwIfAborted();
            return answer;
        },
    });
}
