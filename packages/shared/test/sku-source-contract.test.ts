import { describe, expect, it } from "vitest";
import type { SkuRecord } from "../src";

type SourceIsOptional = { source?: SkuRecord["source"] } extends Pick<SkuRecord, "source"> ? true : false;
const legacyRecordsRemainValid: SourceIsOptional = true;
const acceptedSources: SkuRecord["source"][] = ["feed", "page", undefined];

describe("SKU source contract", () => {
  it("keeps source optional for legacy records and permits page-discovered records", () => {
    expect(legacyRecordsRemainValid).toBe(true);
    expect(acceptedSources).toEqual(["feed", "page", undefined]);
  });
});
