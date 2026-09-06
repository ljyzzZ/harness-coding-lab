export class MaximumStepsError extends Error {
  readonly maxSteps: number;

  constructor({ maxSteps }: { maxSteps: number }) {
    super(`Agent exceeded maximum steps: ${maxSteps}`);
    this.name = "MaximumStepsError";
    this.maxSteps = maxSteps;
  }
}