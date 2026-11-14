import { useEffect, useReducer, useRef } from "react";

import type { Agent } from "@/agent/agent";
import type { TodoSystem } from "@/agent/todos/todo-system";
import { runAgentTurn } from "@/cli/run-agent-turn";

import { initialAgentLoopViewState, reduceAgentEvent } from "../state";

export function useAgentLoop(agent: Agent, todos?: TodoSystem) {
    const [state, dispatch] = useReducer(reduceAgentEvent, undefined, initialAgentLoopViewState);
    const busy = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            agent.abort();
        };
    }, [agent]);

    async function submit(text: string): Promise<void> {
        if (busy.current || !text.trim()) return;
        busy.current = true;
        dispatch({ type: "user_submitted", text });
        dispatch({ type: "run_start" });
        try {
            await runAgentTurn({
                agent,
                text,
                onEvent: (event) => {
                    if (!mounted.current) return;
                    dispatch(event);
                    if (todos) dispatch({ type: "todos_updated", items: todos.snapshot() });
                },
            });
        } catch (error) {
            if (mounted.current && !(error instanceof Error && error.name === "AbortError")) {
                dispatch({ type: "client_error", message: error instanceof Error ? error.message : String(error) });
            }
        } finally {
            busy.current = false;
            if (mounted.current) dispatch({ type: "run_end" });
        }
    }

    function clear(): void {
        if (busy.current) return;
        agent.clearMessages(); // 先清事实记录，成功后才清 UI。
        todos?.write({ merge: false, items: [] });
        dispatch({ type: "cleared" });
    }

    return { state, submit, clear, abort: () => agent.abort() };
}
