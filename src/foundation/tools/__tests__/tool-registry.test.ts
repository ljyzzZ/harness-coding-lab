import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { addTool } from "../add-tool";
import { defineTool } from "../function-tool";
import { ToolRegistry } from "../tool-registry";

describe("ToolRegistry", () => {
  test("returns the add result for valid input", async () => {
    const registry = new ToolRegistry({ tools: [addTool] });

    const result = await registry.invoke({
      name: "add",
      input: { description: "sum two numbers", left: 2, right: 3 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        ok: true,
        summary: "Calculated 2 + 3",
        data: { left: 2, right: 3, sum: 5 },
      });
    }
  });

  test("rejects input without description", async () => {
    const registry = new ToolRegistry({ tools: [addTool] });
    const result = await registry.invoke({
      name: "add",
      input: { left: 2, right: 3 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_TOOL_INPUT" });
  });

  test("rejects non-finite numbers", async () => {
    const registry = new ToolRegistry({ tools: [addTool] });
    const result = await registry.invoke({
      name: "add",
      input: { description: "invalid number", left: Number.NaN, right: 3 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_TOOL_INPUT" });
  });

  test("returns TOOL_NOT_FOUND for an unknown tool", async () => {
    const registry = new ToolRegistry({ tools: [] });
    expect(await registry.invoke({ name: "missing", input: {} })).toEqual({
      ok: false,
      toolName: "missing",
      code: "TOOL_NOT_FOUND",
      error: "Unknown tool: missing",
    });
  });

  test("rejects duplicate tool names", () => {
    expect(() => new ToolRegistry({ tools: [addTool, addTool] })).toThrow(
      "Duplicate tool name: add",
    );
  });

  test("normalizes an unexpected tool exception", async () => {
    const brokenTool = defineTool({
      name: "broken",
      description: "Always fails",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        throw new Error("boom");
      },
    });
    const registry = new ToolRegistry({ tools: [brokenTool] });

    expect(
      await registry.invoke({ name: "broken", input: { description: "test failure" } }),
    ).toMatchObject({ ok: false, code: "TOOL_EXECUTION_FAILED", error: "boom" });
  });

  test("does not invoke a tool after abort", async () => {
    let invokeCount = 0;
    const sideEffectTool = defineTool({
      name: "side_effect",
      description: "Counts calls",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        invokeCount += 1;
        return "done";
      },
    });
    const registry = new ToolRegistry({ tools: [sideEffectTool] });
    const controller = new AbortController();
    controller.abort();

    const result = await registry.invoke({
      name: "side_effect",
      input: { description: "must not run" },
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, code: "ABORTED" });
    expect(invokeCount).toBe(0);
  });
});