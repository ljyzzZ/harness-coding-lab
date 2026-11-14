import { parse, stringify } from "yaml";

import { parseHarnessConfig } from "./schema";
import type { HarnessConfig } from "./schema";

export async function readConfig(path: string): Promise<HarnessConfig | undefined> {
    try {
        return parseHarnessConfig(parse(await Bun.file(path).text()));
    } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
    }
}

export async function requireConfig(path: string): Promise<HarnessConfig> {
    const config = await readConfig(path);
    if (!config) throw new Error("Config file not found: " + path + ". Run config model add first.");
    return config;
}

export async function writeConfig(path: string, input: unknown): Promise<void> {
    const config = parseHarnessConfig(input);
    await Bun.write(path, stringify(config));
}
