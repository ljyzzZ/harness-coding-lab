import { addTool } from "@/foundation/tools/add-tool";
import { ToolRegistry } from "@/foundation/tools/tool-registry";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [toolName, rawInput] = Bun.argv.slice(2);

  if (!toolName || !rawInput) {
    print({
      ok: false,
      code: "INVALID_ARGUMENTS",
      error: "Usage: bun run examples/stage-03-tool-playground.ts <tool> <json-input>",
    });
    process.exitCode = 1;
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch (error) {
    print({
      ok: false,
      toolName,
      code: "INVALID_JSON_INPUT",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const registry = new ToolRegistry({ tools: [addTool] });
  print(await registry.invoke({ name: toolName, input }));
}

await main();