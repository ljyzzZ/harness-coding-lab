import { z } from "zod";

import { defineTool } from "./function-tool";
import { okToolResult } from "./structured-tool-result";

export const addTool = defineTool({
  name: "add",
  description: "Add two finite numbers",
  // finite() 在参数校验阶段排除 Infinity 等非有限数值。
  parameters: z.object({
    description: z.string(),
    left: z.number().finite(),
    right: z.number().finite(),
  }),
  invoke: async ({ left, right }) => {
    // summary 提供简短说明，data 保留输入和结果，供后续程序或模型使用。
    return okToolResult(`Calculated ${left} + ${right}`, {
      left,
      right,
      sum: left + right,
    });
  },
});
