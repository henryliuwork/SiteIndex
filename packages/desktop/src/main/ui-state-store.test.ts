import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectId } from "@siteindex/shared";
import { createUiStateStore } from "./ui-state-store.js";

let root: string;
const project = "synthetic-project" as ProjectId;
const stateFile = () => path.join(root, project, "ui-state.json");

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "siteindex-sort-state-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Desktop uiState sort persistence", () => {
  it("adds sorts to a legacy state without changing columns or page sizes", async () => {
    const store = createUiStateStore(() => root);
    const legacy = '{"columns":{"products.merged":["sku","product"]},"page_sizes":{"products.merged":50}}\n';
    await mkdir(path.dirname(stateFile()), { recursive: true });
    await writeFile(stateFile(), legacy);

    expect(await store.get(project)).toEqual({
      columns: { "products.merged": ["sku", "product"] }, page_sizes: { "products.merged": 50 },
    });
    expect(await readFile(stateFile(), "utf8")).toBe(legacy);

    await store.set(project, { sorts: { "products.merged": { field: "price", dir: "desc" } } });
    const stored = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(stored).toEqual({ columns: { "products.merged": ["sku", "product"] },
      page_sizes: { "products.merged": 50 }, sorts: { "products.merged": { field: "price", dir: "desc" } } });
    const returned = await store.get(project);
    returned.sorts!["products.merged"] = null;
    expect((await store.get(project)).sorts?.["products.merged"]).toEqual({ field: "price", dir: "desc" });
  });

  it("merges table sorts, preserves null clear markers, and serializes concurrent updates", async () => {
    const store = createUiStateStore(() => root);
    await Promise.all([
      store.set(project, { sorts: { "products.merged": { field: "price", dir: "asc" } } }),
      store.set(project, { page_sizes: { "products.merged": 20 } }),
      store.set(project, { sorts: { "seo.pages": { field: "url", dir: "desc" } } }),
    ]);
    await store.set(project, { sorts: { "products.merged": null } });
    expect(await store.get(project)).toEqual({ columns: {}, page_sizes: { "products.merged": 20 },
      sorts: { "products.merged": null, "seo.pages": { field: "url", dir: "desc" } } });
    expect(await store.get("other-project" as ProjectId)).toEqual({ columns: {}, page_sizes: {} });
  });

  it("ignores malformed saved sorts on read and rejects invalid patches without rewriting the file", async () => {
    const store = createUiStateStore(() => root);
    const saved = '{"columns":{},"page_sizes":{},"sorts":{"good":{"field":"sku","dir":"asc"},"bad":{"field":"sku","dir":"up"}}}\n';
    await mkdir(path.dirname(stateFile()), { recursive: true });
    await writeFile(stateFile(), saved);
    expect((await store.get(project)).sorts).toEqual({ good: { field: "sku", dir: "asc" } });
    expect(await readFile(stateFile(), "utf8")).toBe(saved);
    await expect(store.set(project, { sorts: { bad: { field: "", dir: "up" } as never } }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(stateFile(), "utf8")).toBe(saved);
  });
});
