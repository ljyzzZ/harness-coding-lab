import { z } from "zod";

import { defineTool } from "./function-tool";
import { okToolResult } from "./structured-tool-result";

export const addTool = defineTool({
  name: "add",
  description: "Add two finite numbers",
  parameters: z.object({
    description: z.string(),
    left: z.number().finite(),
    right: z.number().finite(),
  }),
  invoke: async ({ left, right }) => {
    return okToolResult(`Calculated ${left} + ${right}`, {
      left,
      right,
      sum: left + right,
    });
  },
});