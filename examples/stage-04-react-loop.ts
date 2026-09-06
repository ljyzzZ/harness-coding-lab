import { z } from "zod";

import { Agent } from "@/agent/agent";
import type {
  AssistantMessage,
  Message,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type {
  ModelProvider,
  ModelProviderInvokeParams,
} from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

import { defineMessagePrinter } from "./message-stream-printer";

interface WeatherObservation {
  city: string;
  condition: string;
  temperatureC: number;
}

function findLatestWeatherExchange(messages: Message[]): {
  toolUse: ToolUseContent;
  toolResult: ToolResultContent;
} | undefined {
  for (let resultIndex = messages.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const resultMessage = messages[resultIndex];
    if (resultMessage?.role !== "tool") continue;

    for (const toolResult of resultMessage.content) {
      for (let useIndex = resultIndex - 1; useIndex >= 0; useIndex -= 1) {
        const useMessage = messages[useIndex];
        if (useMessage?.role !== "assistant") continue;

        const toolUse = useMessage.content.find(
          (item): item is ToolUseContent =>
            item.type === "tool_use" && item.id === toolResult.tool_use_id,
        );
        if (toolUse?.name === "get_weather") return { toolUse, toolResult };
      }
    }
  }
  return undefined;
}

function parseWeatherObservation(content: string): WeatherObservation {
  const value: unknown = JSON.parse(content);
  if (
    typeof value !== "object" ||
    value === null ||
    !("city" in value) ||
    typeof value.city !== "string" ||
    !("condition" in value) ||
    typeof value.condition !== "string" ||
    !("temperatureC" in value) ||
    typeof value.temperatureC !== "number"
  ) {
    throw new Error("get_weather returned an invalid observation");
  }
  return {
    city: value.city,
    condition: value.condition,
    temperatureC: value.temperatureC,
  };
}

class DemoWeatherModelProvider implements ModelProvider {
  constructor(private readonly _city: string) {}

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    params.signal?.throwIfAborted();

    const exchange = findLatestWeatherExchange(params.messages);
    if (!exchange) {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "weather-1",
            name: "get_weather",
            input: { description: `查询${this._city}天气`, city: this._city },
          },
        ],
      };
    }

    const requestedCity = exchange.toolUse.input.city;
    if (typeof requestedCity !== "string") {
      throw new Error("get_weather tool_use did not contain a city");
    }
    const observation = parseWeatherObservation(exchange.toolResult.content);
    if (observation.city !== requestedCity) {
      throw new Error("get_weather observation does not match its tool_use");
    }

    return {
      role: "assistant",
      content: [{
        type: "text",
        text: `${requestedCity}今天${observation.condition}，${observation.temperatureC}°C。`,
      }],
    };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = await this.invoke(params);
    const scripted = new ScriptedModelProvider({ responses: [response] });
    yield* scripted.stream(params);
  }
}

const getWeatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather without network access",
  parameters: z.object({
    description: z.string(),
    city: z.string(),
  }),
  invoke: async ({ city }) => ({ city, condition: "晴", temperatureC: 26 }),
});

const city = Bun.argv[2]?.trim() || "北京";
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: `${city}天气如何？` }],
};

const printMessage = defineMessagePrinter({
  write: async (text) => {
    for (const character of text) {
      process.stdout.write(character);
      if (character !== "\n") await Bun.sleep(20);
    }
  },
});

const provider = new DemoWeatherModelProvider(city);
const agent = new Agent({
  model: new Model({ name: "scripted", provider }),
  prompt: "Use get_weather when the user asks about weather.",
  tools: [getWeatherTool],
});
const userText = userMessage.content.find((item) => item.type === "text")?.text ?? "";
let steps = 0;

console.log(`[user] ${userText}`);
for await (const event of agent.stream(userMessage)) {
  if (event.type !== "message") continue;
  if (event.message.role === "assistant") steps += 1;
  await printMessage(event.message);
}

console.log(`[done] steps=${steps} messages=${agent.messages.length}`);