import type {
    AssistantMessage,
    Message,
    NonSystemMessage,
    ToolResultContent,
    ToolUseContent,
} from "@/foundation/messages";
import { formatTranscript } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type {
    ModelProvider,
    ModelProviderInvokeParams,
} from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { addTool, ToolRegistry } from "@/foundation/tools";

function textOf(message: AssistantMessage): string {
    let text = "";
    for (const content of message.content) {
        if (content.type === "text") text += content.text;
    }
    return text;
}

function findToolUse(message: AssistantMessage): ToolUseContent {
    for (const content of message.content) {
        if (content.type === "tool_use") return content;
    }
    throw new Error("Model response did not contain a tool_use");
}

function findLatestToolResult(messages: Message[]): ToolResultContent | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "tool") continue;

        for (const content of message.content) {
            if (content.type === "tool_result") return content;
        }
    }
    return undefined;
}

function readSum(value: unknown): number {
    if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) {
        throw new Error("add Tool did not return a successful StructuredToolResult");
    }
    if (!("data" in value) || typeof value.data !== "object" || value.data === null) {
        throw new Error("add Tool result did not contain data");
    }
    if (!("sum" in value.data) || typeof value.data.sum !== "number") {
        throw new Error("add Tool result did not contain a numeric sum");
    }
    return value.data.sum;
}

class DemoAddModelProvider implements ModelProvider {
    private readonly _left: number;
    private readonly _right: number;

    constructor({ left, right }: { left: number; right: number }) {
        this._left = left;
        this._right = right;
    }

    async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
        params.signal?.throwIfAborted();

        const toolResult = findLatestToolResult(params.messages);
        if (!toolResult) {
            return {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "add-1",
                        name: "add",
                        input: {
                            description: "计算两个数字的和",
                            left: this._left,
                            right: this._right,
                        },
                    },
                ],
            };
        }

        const observation: unknown = JSON.parse(toolResult.content);
        const sum = readSum(observation);
        return {
            role: "assistant",
            content: [{ type: "text", text: `计算结果是 ${sum}。` }],
        };
    }

    async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
        const response = await this.invoke(params);
        const scripted = new ScriptedModelProvider({ responses: [response] });
        yield* scripted.stream(params);
    }
}

const [leftText = "2", rightText = "3"] = Bun.argv.slice(2);
const left = Number(leftText);
const right = Number(rightText);
if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error("Usage: bun run examples/foundation-demo.ts <left> <right>");
}

const registry = new ToolRegistry({ tools: [addTool] });
const provider = new DemoAddModelProvider({ left, right });
const model = new Model({ name: "demo-add", provider });
const transcript: NonSystemMessage[] = [
    {
        role: "user",
        content: [{ type: "text", text: `请计算 ${left} + ${right}。` }],
    },
];

// 第一次模型调用根据用户消息产生 Tool call。
const toolRequest = await model.invoke({
    prompt: "需要计算时调用 add Tool。",
    messages: transcript,
    tools: registry.list(),
});
transcript.push(toolRequest);

const toolUse = findToolUse(toolRequest);
const execution = await registry.invoke({
    name: toolUse.name,
    input: toolUse.input,
});

// Registry 失败时记录执行错误；成功时把 Tool 自身的 structured result 作为 observation。
const observation = execution.ok ? execution.value : execution;
const observationText = JSON.stringify(observation);
if (observationText === undefined) {
    throw new Error("Tool observation could not be serialized");
}
transcript.push({
    role: "tool",
    content: [
        {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: observationText,
        },
    ],
});

// 第二次模型调用读取刚刚追加的真实 Tool result，再产生最终回答。
let finalMessage: AssistantMessage | undefined;
console.log("Cumulative snapshots:");
for await (const snapshot of model.stream({
    prompt: "根据 Tool observation 回答用户。",
    messages: transcript,
    tools: registry.list(),
})) {
    console.log(textOf(snapshot));
    finalMessage = snapshot;
}

if (!finalMessage) {
    throw new Error("Model stream did not yield a response");
}

transcript.push(finalMessage);

console.log("\nCanonical transcript:");
console.log(formatTranscript(transcript));