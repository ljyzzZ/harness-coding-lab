import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { requireConfig } from "../config-file";
import { registerModelCommands } from "../model-commands";

const directories: string[] = [];
const output: string[] = [];
const log = spyOn(console, "log").mockImplementation((value: unknown) => {
    output.push(String(value));
});
afterAll(() => log.mockRestore());

afterEach(async () => {
    output.length = 0;
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "harness-model-commands-"));
    directories.push(directory);
    const path = join(directory, "harness.config.yaml");
    async function run(...args: string[]) {
        const program = new Command()
            .option("-c, --config <path>", "Model config file", "harness.config.yaml")
            .exitOverride();
        registerModelCommands(program);
        await program.parseAsync(["--config", path, "config", "model", ...args], { from: "user" });
    }
    const add = (name: string, ...extra: string[]) =>
        run("add", name, "--provider", "openai", "--model", "test-model", "--api-key-env", "TEST_API_KEY", ...extra);
    return { path, run, add };
}

describe("model commands", () => {
    test("adds, lists, selects and removes models", async () => {
        const { path, run, add } = await fixture();
        await add("local");
        expect((await requireConfig(path)).defaultModel).toBe("local");
        await add("backup", "--base-url", "https://example.com/v1");
        output.length = 0;
        await run("list");
        expect(output).toEqual(["* local (openai/test-model)", "  backup (openai/test-model)"]);
        await run("set-default", "backup");
        await run("remove", "local");
        const config = await requireConfig(path);
        expect(config.defaultModel).toBe("backup");
        expect(Object.keys(config.models)).toEqual(["backup"]);
        expect(config.models.backup?.baseURL).toBe("https://example.com/v1");
    });

    test("leaves the file unchanged when a command fails", async () => {
        const { path, run, add } = await fixture();
        await add("local");
        const before = await Bun.file(path).text();
        const invalidOperations = [
            () => add("local"),
            () => run("remove", "local"),
            () => run("remove", "missing"),
            () => run("set-default", "missing"),
            () => add("backup", "--base-url", "invalid-url"),
        ];
        for (const operation of invalidOperations) {
            await expect(operation()).rejects.toThrow();
            expect(await Bun.file(path).text()).toBe(before);
        }
    });
});
