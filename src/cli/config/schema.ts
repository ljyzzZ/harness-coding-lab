import { z } from "zod";

export type ModelProviderName = "openai" | "anthropic";
export interface ModelConfig {
    provider: ModelProviderName;
    model: string;
    baseURL?: string;
    apiKeyEnv: string;
    options?: Record<string, unknown>;
}
export interface HarnessConfig {
    defaultModel: string;
    models: Record<string, ModelConfig>;
}

const harnessConfigSchema = z
    .object({
        defaultModel: z.string().min(1),
        models: z.record(
            z.string().min(1),
            z
                .object({
                    provider: z.enum(["openai", "anthropic"]),
                    model: z.string().min(1),
                    baseURL: z.string().url().optional(),
                    apiKeyEnv: z.string().min(1),
                    options: z.record(z.string(), z.unknown()).optional(),
                })
                .strict(),
        ),
    })
    .strict();

export function parseHarnessConfig(input: unknown): HarnessConfig {
    const result = harnessConfigSchema.safeParse(input);
    if (!result.success) {
        // 不输出原配置对象，避免把误填到配置里的密钥回显。
        throw new Error(
            result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n"),
        );
    }
    const config = result.data;
    // TODO 1：调用下面的 resolveDefaultModel(config)，验证 defaultModel 指向真实 key。
    // 成功则 return config；不要读取 process.env，也不要将缺省模型偷偷换成第一个模型。
    resolveDefaultModel(config);
    return config;
}

export function resolveDefaultModel(config: HarnessConfig): ModelConfig {
    if (!Object.hasOwn(config.models, config.defaultModel)) {
        throw new Error(`defaultModel: unknown model ${config.defaultModel}`);
    }
    return config.models[config.defaultModel]!;
}
