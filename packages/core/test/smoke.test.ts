import { describe, expect, it } from "vitest";
import { CORE_SCHEMA_VERSION, compareKeys } from "../src";

describe("core smoke", () => {
  it("uses the shared schema version", () => {
    expect(CORE_SCHEMA_VERSION).toBe("1.1");
  });
  it("sorts by code unit, not locale", () => {
    expect(["b", "B", "a", "_"].sort(compareKeys)).toEqual(["B", "_", "a", "b"]);
  });
});
