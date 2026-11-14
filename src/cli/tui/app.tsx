import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useEffect, useState, useSyncExternalStore } from "react";

import type { Agent } from "@/agent/agent";
import type { TodoSystem } from "@/agent/todos/todo-system";
import { formatTranscript } from "@/foundation/messages";

import { useAgentLoop } from "./hooks/use-agent-loop";
import type { HumanInputQueue, PendingHumanInput } from "./human-input";
import { parseSlashCommand } from "./state";

const QuestionInput = memo(function QuestionInput({
    pending,
    humanInput,
}: {
    pending: PendingHumanInput;
    humanInput: HumanInputQueue;
}) {
    const [answer, setAnswer] = useState("");
    if (pending.prompt.kind !== "question") return null;
    return (
        <Box flexDirection="column">
            <Text>{pending.prompt.question}</Text>
            <Text>{pending.prompt.choices?.join(" / ") ?? "Type your answer"}</Text>
            <TextInput
                value={answer}
                onChange={setAnswer}
                onSubmit={(text) => {
                    if (text.trim()) humanInput.answer(pending.id, text);
                }}
            />
        </Box>
    );
});

export const App = memo(function App({
    agent,
    todos,
    humanInput,
    modelName,
}: {
    modelName: string;
    agent: Agent;
    todos: TodoSystem;
    humanInput: HumanInputQueue;
}) {
    const { state, submit, clear, abort } = useAgentLoop(agent, todos);
    const [input, setInput] = useState("");
    const [notice, setNotice] = useState("");
    const { exit } = useApp();
    const pending = useSyncExternalStore(
        (listener) => humanInput.subscribe(listener),
        () => humanInput.current,
    );
    useEffect(() => () => humanInput.cancelAll(), [humanInput]);
    useInput((keyInput, key) => {
        if (key.ctrl && keyInput === "c") {
            if (agent.streaming) abort();
            else exit();
            return;
        }
        if (key.ctrl || pending?.prompt.kind !== "approval") return;
        const decisions: Record<string, string> = {
            a: "allow_once",
            p: "allow_always_project",
            d: "deny",
        };
        const answer = decisions[keyInput];
        if (answer) humanInput.answer(pending.id, answer);
    });

    function handleInput(text: string): void {
        if (agent.streaming || pending) return;
        setInput("");
        setNotice("");
        try {
            const command = parseSlashCommand(text);
            if (!command) {
                void submit(text);
                return;
            }
            if (command.name === "clear") clear();
            if (command.name === "help") setNotice("/clear  /help  /exit");
            if (command.name === "exit") exit();
        } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error));
        }
    }

    return (
        <Box flexDirection="column">
            <Text>{formatTranscript(state.messages)}</Text>
            <Text>{state.streaming ? "Working…" : "Ready"}</Text>
            <Text>{state.error ?? notice}</Text>
            <Text>{state.todos.map((item) => `[${item.status}] ${item.text}`).join("\n")}</Text>
            <Text>
                Model: {modelName} | Input tokens: {state.tokenUsage.latestInputTokens} | Total:{" "}
                {state.tokenUsage.sessionTotalTokens}
            </Text>
            {pending?.prompt.kind === "approval" && (
                <Box flexDirection="column">
                    <Text>
                        {pending.prompt.request.toolName}: {JSON.stringify(pending.prompt.request.toolUse.input)}
                    </Text>
                    <Text>a: allow once | p: allow for project | d: deny</Text>
                </Box>
            )}
            {pending?.prompt.kind === "question" && (
                <QuestionInput key={pending.id} pending={pending} humanInput={humanInput} />
            )}
            {!pending && (
                <TextInput value={input} onChange={setInput} focus={!state.streaming} onSubmit={handleInput} />
            )}
        </Box>
    );
});

export function mountApp(options: { agent: Agent; todos: TodoSystem; humanInput: HumanInputQueue; modelName: string }) {
    return render(<App {...options} />, { exitOnCtrlC: false });
}
