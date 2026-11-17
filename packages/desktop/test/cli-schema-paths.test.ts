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

  it("accepts Core's bundled schema fallback when older path patterns are absent", () => {
    const bundle = 'new URL(`${sourceRelativePath}/${name}`,moduleUrl);new URL(`./schemas/${name}`,moduleUrl)';
    const result = rewriteBundledCliSchemaPaths(bundle);
    expect(result.source).toBe(bundle);
    expect(result.replacementCount).toBe(0);
  });

  it("fails packaging when no bundled schema path exists", () => {
    expect(() => rewriteBundledCliSchemaPaths('new URL("./other/file", import.meta.url)')).toThrow(
      "CLI bundle has no packaged schema path (./schemas/)",
    );
  });
});
