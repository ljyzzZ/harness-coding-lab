import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider } from "@/foundation/models/model-provider";
import { AnthropicModelProvider } from "@/community/anthropic/model-provider";
import { OpenAIModelProvider } from "@/community/openai/model-provider";

type Vendor = "openai" | "anthropic";

function visibleText(message: AssistantMessage): string {
    return message.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

function redactThinking(message: AssistantMessage): AssistantMessage {
    return {
        ...message,
        content: message.content.map((item) =>
            item.type === "thinking" ? { ...item, thinking: "[hidden]" } : item,
        ),
    };
}

async function main(): Promise<void> {
    const vendor = Bun.argv[2];
    if (vendor !== "openai" && vendor !== "anthropic") {
        console.log("Usage: bun run examples/stage-07-real-model.ts <openai|anthropic>");
        return;
    }

    const config: Record<
        Vendor,
        {
            apiKey: string | undefined;
            baseURL: string | undefined;
            modelName: string;
            providerName: string;
        }
    > = {
        openai: {
            apiKey: Bun.env.OPENAI_API_KEY?.trim(),
            baseURL: Bun.env.OPENAI_BASE_URL?.trim() || undefined,
            modelName: Bun.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
            providerName: "OpenAI",
        },
        anthropic: {
            apiKey: Bun.env.ANTHROPIC_API_KEY?.trim(),
            baseURL: Bun.env.ANTHROPIC_BASE_URL?.trim() || undefined,
            modelName: Bun.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514",
            providerName: "Anthropic",
        },
    };
    const selected = config[vendor];

    if (!selected.apiKey) {
        console.log(`Missing ${vendor === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}.`);
        console.log("Configure the key in the project-root .env file and run this example again.");
        return;
    }

    const provider: ModelProvider =
        vendor === "openai"
            ? new OpenAIModelProvider({
                  apiKey: selected.apiKey,
                  baseURL: selected.baseURL,
              })
            : new AnthropicModelProvider({
                  apiKey: selected.apiKey,
                  baseURL: selected.baseURL,
              });
    const model = new Model({ name: selected.modelName, provider });
    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: "用一句话解释 ReAct agent loop。" }],
    };
    const startedAt = performance.now();
    let finalMessage: AssistantMessage | undefined;
    let printedText = "";

    console.log(`provider=${selected.providerName} model=${selected.modelName}`);
    for await (const snapshot of model.stream({
        prompt: "Answer concisely. Do not expose hidden reasoning.",
        messages: [userMessage],
    })) {
        const text = visibleText(snapshot);
        process.stdout.write(text.slice(printedText.length));
        printedText = text;
        finalMessage = snapshot;
    }
    process.stdout.write("\n");

    if (!finalMessage) throw new Error("Provider stream returned no snapshots");

    console.log(JSON.stringify(redactThinking(finalMessage), null, 2));
    console.log(
        `tokens prompt=${finalMessage.usage?.promptTokens ?? "n/a"} ` +
            `output=${finalMessage.usage?.completionTokens ?? "n/a"} ` +
            `total=${finalMessage.usage?.totalTokens ?? "n/a"}`,
    );
    console.log(`elapsed=${Math.round(performance.now() - startedAt)}ms`);
}

await main();
