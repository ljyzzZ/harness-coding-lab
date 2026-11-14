import type { AssistantMessage, NonSystemMessage } from "@/foundation/messages";

export function calculateTokenUsage(messages: NonSystemMessage[]) {
    const assistantWithUsage = messages.filter(
        (message): message is AssistantMessage => message.role === "assistant" && message.usage !== undefined,
    );

    // 标准实现示例：session total 是所有已报告 totalTokens 的和。
    const sessionTotalTokens = assistantWithUsage.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0);

    const latestInputTokens = assistantWithUsage.at(-1)?.usage?.promptTokens ?? 0;
    return { latestInputTokens, sessionTotalTokens };
}
