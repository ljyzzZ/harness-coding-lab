import { OpenAIModelProvider } from "@/community/openai/model-provider";
import { AnthropicModelProvider } from "@/community/anthropic/model-provider";
import { Model } from "@/foundation/models";

import type { HarnessConfig } from "./schema";
import { resolveDefaultModel } from "./schema";

export function defineConfiguredModel(
    config: HarnessConfig,
    env: Record<string, string | undefined> = process.env,
): Model {
    const selected = resolveDefaultModel(config);
    const apiKey = env[selected.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing environment variable: ${selected.apiKeyEnv}`);
    const providerOptions = { baseURL: selected.baseURL, apiKey };
    const provider =
        selected.provider === "openai"
            ? new OpenAIModelProvider(providerOptions)
            : new AnthropicModelProvider(providerOptions);
    return new Model({ name: selected.model, provider, modelOptions: selected.options });
}
