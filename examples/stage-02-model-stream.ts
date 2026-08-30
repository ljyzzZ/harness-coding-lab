import type { AssistantMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
};

const provider = new ScriptedModelProvider({ responses: [response] });
const model = new Model({ name: "scripted", provider });
let finalMessage: AssistantMessage | undefined;

for await (const snapshot of model.stream({ prompt: "", messages: [] })) {
  const text = snapshot.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");

  process.stdout.write(`\r${text}`);
  finalMessage = snapshot;
  await Bun.sleep(50);
}

process.stdout.write("\n");

if (!finalMessage) {
  throw new Error("Model stream did not yield a response");
}

console.log(JSON.stringify(finalMessage, null, 2));