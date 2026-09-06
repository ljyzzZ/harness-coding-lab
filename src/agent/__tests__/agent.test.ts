import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
  AssistantMessage,
  Message,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";
import type { Tool } from "@/foundation/tools";

import { Agent } from "../agent";
import { MaximumStepsError } from "../errors";

const weatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather",
  parameters: z.object({ description: z.string(), city: z.string() }),
  invoke: async ({ city }) => ({ city, condition: "晴", temperatureC: 26 }),
});

function userMessage(city: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${city}天气如何？` }],
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFromJson(content: string): Record<string, unknown> {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object Tool observation");
  }
  return value;
}

class WeatherLoopProvider implements ModelProvider {
  constructor(private readonly _city: string) {}

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    params.signal?.throwIfAborted();

    const exchange = findLatestWeatherExchange(params.messages);
    if (!exchange) {
      return {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "weather-1",
          name: "get_weather",
          input: { description: `查询${this._city}天气`, city: this._city },
        }],
      };
    }

    const observation = recordFromJson(exchange.toolResult.content);
    if (observation.ok === false) {
      const code = typeof observation.code === "string"
        ? observation.code
        : "UNKNOWN_TOOL_ERROR";
      return {
        role: "assistant",
        content: [{ type: "text", text: `天气查询失败：${code}` }],
      };
    }

    const city = exchange.toolUse.input.city;
    if (
      typeof city !== "string" ||
      observation.city !== city ||
      typeof observation.condition !== "string" ||
      typeof observation.temperatureC !== "number"
    ) {
      throw new Error("Invalid or mismatched weather observation");
    }
    return {
      role: "assistant",
      content: [{
        type: "text",
        text: `${city}今天${observation.condition}，${observation.temperatureC}°C。`,
      }],
    };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = await this.invoke(params);
    const scripted = new ScriptedModelProvider({ responses: [response] });
    yield* scripted.stream(params);
  }
}

async function drain(agent: Agent, city = "北京"): Promise<void> {
  for await (const _event of agent.stream(userMessage(city))) {
    // 消费完整 event stream；断言统一读取 agent.messages。
  }
}

function defineWeatherAgent(options: {
  city?: string;
  tools?: Tool[];
  maxSteps?: number;
} = {}): Agent {
  const provider = new WeatherLoopProvider(options.city ?? "北京");
  return new Agent({
    model: new Model({ name: "scripted", provider }),
    prompt: "Answer with tools when needed",
    tools: options.tools ?? [weatherTool],
    maxSteps: options.maxSteps,
  });
}

describe("Agent", () => {
  test("feeds the real Tool observation into the next model step", async () => {
    const receivedCities: string[] = [];
    const rainyWeatherTool = defineTool({
      name: "get_weather",
      description: "Return a test-specific weather observation",
      parameters: z.object({ description: z.string(), city: z.string() }),
      invoke: async ({ city }) => {
        receivedCities.push(city);
        return { city, condition: "雨", temperatureC: 17 };
      },
    });
    const agent = defineWeatherAgent({ city: "上海", tools: [rainyWeatherTool] });
    await drain(agent, "上海");

    expect(agent.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(receivedCities).toEqual(["上海"]);
    const toolMessage = agent.messages.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content[0]?.content ?? "null")).toEqual({
      city: "上海",
      condition: "雨",
      temperatureC: 17,
    });
    expect(agent.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "上海今天雨，17°C。" }],
    });
  });

  test("preserves tool_use_id in the result message", async () => {
    const agent = defineWeatherAgent();
    await drain(agent);
    const toolMessage = agent.messages.find((message) => message.role === "tool");

    expect(toolMessage?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "weather-1",
    });
  });

  test("turns an unknown tool into an observation", async () => {
    const agent = defineWeatherAgent({ tools: [] });
    await drain(agent);
    const toolMessage = agent.messages.find((message) => message.role === "tool");

    expect(toolMessage?.content[0]?.content).toContain("TOOL_NOT_FOUND");
    expect(agent.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "天气查询失败：TOOL_NOT_FOUND" }],
    });
  });

  test("fails with a typed error after maxSteps", async () => {
    const agent = defineWeatherAgent({ maxSteps: 1 });
    expect(drain(agent)).rejects.toBeInstanceOf(MaximumStepsError);
  });
});