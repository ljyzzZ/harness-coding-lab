import type { z } from "zod";

export interface FunctionTool<
  P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
  R = unknown,
> {
  name: string;
  description: string;
  parameters: P;
  invoke(input: z.infer<P>, signal?: AbortSignal): Promise<R>;
}

export type Tool = FunctionTool;

export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>(options: {
  name: string;
  description: string;
  parameters: P;
  invoke(input: z.infer<P>, signal?: AbortSignal): Promise<R>;
}): FunctionTool<P, R> {
  // 标准实现示例：返回同一个对象即可保留 P 和 R 的完整泛型信息。
  return options;
}