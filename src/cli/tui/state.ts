import type { AgentEvent } from "@/agent/agent-event";
import type { TodoItem } from "@/agent/todos/todo-system";
import type { NonSystemMessage } from "@/foundation/messages";

import { calculateTokenUsage } from "./token-usage";

export interface AgentLoopViewState {
    messages: NonSystemMessage[];
    streaming: boolean;
    tokenUsage: { latestInputTokens: number; sessionTotalTokens: number };
    error?: string;
    todos: TodoItem[];
}
export interface SlashCommand {
    name: "clear" | "help" | "exit";
    args: string[];
}
export type AgentLoopEvent =
    | AgentEvent
    | { type: "user_submitted"; text: string }
    | { type: "cleared" }
    | { type: "todos_updated"; items: TodoItem[] }
    | { type: "run_start" }
    | { type: "run_end"; status?: "completed" | "failed" | "aborted" }
    | { type: "client_error"; message: string };

export function initialAgentLoopViewState(): AgentLoopViewState {
    return {
        messages: [],
        streaming: false,
        tokenUsage: { latestInputTokens: 0, sessionTotalTokens: 0 },
        todos: [],
    };
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return;
    const [command, ...args] = trimmed.slice(1).split(/\s+/);
    if (command !== "clear" && command !== "help" && command !== "exit") {
        throw new Error(`Unknown slash command: ${command}`);
    }
    return { name: command, args };
}

export function reduceAgentEvent(state: AgentLoopViewState, event: AgentLoopEvent): AgentLoopViewState {
    switch (event.type) {
        case "message": {
            const messages = [...state.messages, event.message];
            return { ...state, messages, tokenUsage: calculateTokenUsage(messages) };
        }
        case "user_submitted":
            return {
                ...state,
                messages: [
                    ...state.messages,
                    {
                        role: "user",
                        content: [{ type: "text", text: event.text }],
                    },
                ],
            };
        case "run_start":
            return { ...state, streaming: true, error: undefined };
        case "run_end":
            return { ...state, streaming: false };
        case "client_error":
            return { ...state, error: event.message };
        case "todos_updated":
            return { ...state, todos: event.items.map((item) => ({ ...item })) };
        case "cleared":
            return initialAgentLoopViewState();
        case "progress":
            // 进度不是新消息；累计内容不能反复追加到历史或重复计费。
            return state;
    }
}
