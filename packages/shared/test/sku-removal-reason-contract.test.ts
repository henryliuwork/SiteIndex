import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SkuRecord } from "../src";

const acceptedReasons: NonNullable<SkuRecord["removed_reason"]>[] = [
  "feed_absent_404",
  "feed_absent_aged",
  "superseded_by_feed",
];

describe("SKU removal reason contract", () => {
  it("keeps existing reasons and adds the Feed takeover reason to the schema", () => {
    const schemaUrl = new URL("../../../schemas/sku.schema.json", import.meta.url);
    const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as {
      properties: { removed_reason: { enum: string[] } };
    };

    expect(acceptedReasons).toEqual([
      "feed_absent_404",
      "feed_absent_aged",
      "superseded_by_feed",
    ]);
    expect(schema.properties.removed_reason.enum).toEqual(acceptedReasons);
  });
});
