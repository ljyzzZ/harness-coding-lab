import { describe, expect, test } from "bun:test";

import { main } from "../index";

describe("cli", () => {
  test("exports an entrypoint", () => {
    expect(main).toBeFunction();
  });
});