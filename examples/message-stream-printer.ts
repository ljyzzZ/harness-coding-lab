import type { AssistantMessage, ToolMessage } from "@/foundation/messages";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

/** 在展示层逐行重放完整消息，write 可注入终端输出或测试收集函数。 */
export function defineMessagePrinter({ write }: {
  write: (text: string) => void | Promise<void>;
}): (message: AssistantMessage | ToolMessage) => Promise<void> {
  return async (message) => {
    if (message.role === "tool") {
      for (const item of message.content) {
        await write(`[tool/tool_result] #${item.tool_use_id} ${item.content}`);
        await write("\n");
      }
      return;
    }

    let contentIndex = 0;
    let written = "";
    let lineOpen = false;

    async function printSnapshot(snapshot: AssistantMessage, complete: boolean): Promise<void> {
      while (contentIndex < snapshot.content.length) {
        const item = snapshot.content[contentIndex];
        if (!item) break;
        const label = item.type === "text" ? "assistant" : `assistant/${item.type}`;
        const body = item.type === "text" ? item.text
          : item.type === "thinking" ? item.thinking : item.name;

        if (!lineOpen) {
          await write(`[${label}] `);
          lineOpen = true;
        }
        await write(body.slice(written.length));
        written = body;

        if (!complete && contentIndex === snapshot.content.length - 1) break;
        if (item.type === "tool_use") await write(` #${item.id}`);
        await write("\n");
        contentIndex += 1;
        written = "";
        lineOpen = false;
      }
    }

    const replay = new ScriptedModelProvider({ responses: [message] });
    for await (const snapshot of replay.stream({ model: "display-replay", messages: [] })) {
      await printSnapshot(snapshot, false);
    }
    await printSnapshot(message, true);
  };
}