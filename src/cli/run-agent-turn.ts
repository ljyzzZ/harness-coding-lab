import type { Agent } from "@/agent/agent";
import type { AgentEvent } from "@/agent/agent-event";

export async function runAgentTurn(options: {
    agent: Agent;
    text: string;
    onEvent: (event: AgentEvent) => void | Promise<void>;
}): Promise<void> {
    if (!options.text.trim()) return;
    for await (const event of options.agent.stream({
        role: "user",
        content: [{ type: "text", text: options.text }],
    })) {
        await options.onEvent(event);
    }
}
