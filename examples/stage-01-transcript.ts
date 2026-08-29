import type { Message } from "@/foundation/messages";
import { formatTranscript } from "@/foundation/messages";

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "北京天气如何？" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "call-1", name: "weather", input: { city: "北京" } }],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "call-1", content: "晴，26°C" }],
  },
  { role: "assistant", content: [{ type: "text", text: "北京今天晴，26°C。" }] },
];

console.info(formatTranscript(messages));