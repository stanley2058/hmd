import { describe, expect, test } from "bun:test";

import { parseDuration } from "../src/duration.ts";

describe("parseDuration", () => {
  test("parses cache durations", () => {
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(() => parseDuration("later")).toThrow("Invalid duration");
  });
});
