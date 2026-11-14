import { Agent } from "@/agent/agent";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { formatTranscript } from "@/foundation/messages";
import { runAgentTurn } from "@/cli/run-agent-turn";

const agent = new Agent({
    prompt: "",
    tools: [],
    model: new Model({
        name: "scripted",
        provider: new ScriptedModelProvider({
            responses: [{ role: "assistant", content: [{ type: "text", text: "client ready" }] }],
        }),
    }),
});
const onInterrupt = () => agent.abort();
process.on("SIGINT", onInterrupt);
try {
    await runAgentTurn({
        agent,
        text: "hello",
        onEvent: (event) => {
            if (event.type === "message") console.log(formatTranscript([event.message]));
        },
    });
} finally {
    process.off("SIGINT", onInterrupt);
}
