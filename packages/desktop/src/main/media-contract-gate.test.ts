import { describe, expect, it } from "vitest";
import { isMediaPrepareContractOpen } from "./media-contract-gate.js";

describe("media.prepare hosted acceptance gate", () => {
  it("does not claim production acceptance while the shared contract is pending", () => {
    expect(isMediaPrepareContractOpen(["media.prepare", "edm.exportIndex"])).toBe(false);
  });

  it("allows the hosted production path only after the contract marker is removed", () => {
    expect(isMediaPrepareContractOpen(["edm.exportIndex"])).toBe(true);
    expect(isMediaPrepareContractOpen([])).toBe(true);
  });
});
