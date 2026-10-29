import { describe, expect, it } from "vitest";
import { rewriteBundledCliSchemaPaths } from "../scripts/cli-schema-paths.mjs";

describe("packaged CLI schema paths", () => {
  it("rewrites Core bundle URLs to the sibling resources/schemas directory", () => {
    const bundle = [
      'new URL("../../../../schemas/sku.schema.json", import.meta.url)',
      'new URL("../../../schemas/site.schema.json", import.meta.url)',
      "new URL(`../../../schemas/${name}.schema.json`, import.meta.url)",
    ].join(";");

    const result = rewriteBundledCliSchemaPaths(bundle);

    expect(result.replacementCount).toBe(3);
    expect(result.source).not.toMatch(/\.\.\/\.\.\/\.\.\/schemas\//u);
    expect(result.source).not.toMatch(/\.\.\/\.\.\/\.\.\/\.\.\/schemas\//u);
    expect(result.source).toContain('new URL("./schemas/sku.schema.json", import.meta.url)');
    expect(result.source).toContain('new URL("./schemas/site.schema.json", import.meta.url)');
    expect(result.source).toContain("new URL(`./schemas/${name}.schema.json`, import.meta.url)");
    expect(new URL("./schemas/sku.schema.json", "file:///opt/siteindex/resources/cli.js").href).toBe(
      "file:///opt/siteindex/resources/schemas/sku.schema.json",
    );
  });

  it("fails packaging when either Core schema path pattern is missing", () => {
    expect(() => rewriteBundledCliSchemaPaths('new URL("../../../../schemas/sku.schema.json")')).toThrow(
      "CLI bundle is missing expected schema path prefix: ../../../schemas/",
    );
  });
});
