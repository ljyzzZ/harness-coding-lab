import { Command, Option } from "commander";

import { readConfig, requireConfig, writeConfig } from "./config-file";
import type { ModelProviderName } from "./schema";

interface AddModelOptions {
    provider: ModelProviderName;
    model: string;
    apiKeyEnv: string;
    baseUrl?: string;
}

export function registerModelCommands(program: Command): void {
    const models = program
        .command("config")
        .description("Manage configuration")
        .command("model")
        .description("Manage model profiles");
    const configPath = () => program.opts<{ config: string }>().config;

    models
        .command("list")
        .description("List configured models")
        .action(async () => {
            const config = await requireConfig(configPath());
            for (const [name, model] of Object.entries(config.models)) {
                const marker = name === config.defaultModel ? "*" : " ";
                console.log(marker + " " + name + " (" + model.provider + "/" + model.model + ")");
            }
        });

    models
        .command("add <name>")
        .description("Add a model profile")
        .addOption(
            new Option("--provider <provider>", "Model provider")
                .choices(["openai", "anthropic"])
                .makeOptionMandatory(),
        )
        .requiredOption("--model <model>", "Provider model name")
        .requiredOption("--api-key-env <name>", "API key environment variable name")
        .option("--base-url <url>", "Provider base URL")
        .action(async (name: string, options: AddModelOptions) => {
            const path = configPath();
            const current = await readConfig(path);
            if (current && Object.hasOwn(current.models, name)) {
                throw new Error("Model already exists: " + name);
            }
            await writeConfig(path, {
                defaultModel: current?.defaultModel ?? name,
                models: {
                    ...current?.models,
                    [name]: {
                        provider: options.provider,
                        model: options.model,
                        apiKeyEnv: options.apiKeyEnv,
                        baseURL: options.baseUrl,
                    },
                },
            });
            console.log("Added model: " + name);
        });

    models
        .command("remove <name>")
        .description("Remove a model profile")
        .action(async (name: string) => {
            const path = configPath();
            const current = await requireConfig(path);
            if (!Object.hasOwn(current.models, name)) throw new Error("Unknown model: " + name);
            if (current.defaultModel === name) {
                throw new Error("Cannot remove the default model. Run config model set-default <name> first.");
            }
            const remaining = { ...current.models };
            delete remaining[name];
            await writeConfig(path, { ...current, models: remaining });
            console.log("Removed model: " + name);
        });

    models
        .command("set-default <name>")
        .description("Select the default model")
        .action(async (name: string) => {
            const path = configPath();
            const current = await requireConfig(path);
            if (!Object.hasOwn(current.models, name)) throw new Error("Unknown model: " + name);
            await writeConfig(path, { ...current, defaultModel: name });
            console.log("Default model: " + name);
        });
}
