import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const indexDirectory = resolve(repositoryRoot, "fixtures/expected/project/index");

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(indexDirectory, relativePath), "utf8")) as T;
}

async function readJsonl<T>(relativePath: string): Promise<T[]> {
  const source = await readFile(resolve(indexDirectory, relativePath), "utf8");
  return source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

const reportDirectory = resolve(indexDirectory, "reports/daily");
const reportFiles = (await readdir(reportDirectory)).filter((name) => name.endsWith(".md")).sort();
const dailyReports = await Promise.all(reportFiles.map(async (name) => ({
  date: basename(name, ".md"),
  markdown: await readFile(resolve(reportDirectory, name), "utf8"),
})));

const mockData = {
  generatedSkuCount: 10_000,
  projects: [
    { id: "kingsyard", name: "Kingsyard", domain: "kingsyard.com", source: "fixture" },
    { id: "riverstone", name: "Riverstone Outdoor", domain: "riverstoneoutdoor.com", source: "generated" },
  ],
  site: await readJson<Record<string, unknown>>("site.json"),
  skus: await readJsonl<Record<string, unknown>>("catalog/skus.jsonl"),
  products: await readJsonl<Record<string, unknown>>("views/products.jsonl"),
  stock: await readJsonl<Record<string, unknown>>("inventory/latest.jsonl"),
  categories: await readJson<unknown[]>("catalog/categories.json"),
  events: await readJsonl<Record<string, unknown>>("inventory/events/2026-10.jsonl"),
  pages: await readJsonl<Record<string, unknown>>("catalog/pages.jsonl"),
  blogs: await readJsonl<Record<string, unknown>>("content/blog_index.jsonl"),
  keywords: await readJsonl<Record<string, unknown>>("content/keywords.jsonl"),
  runs: await readJsonl<Record<string, unknown>>("logs/runs.jsonl"),
  dailyReports,
};

if (mockData.skus.length === 0 || mockData.products.length === 0) {
  throw new Error("Kingsyard mock fixtures are empty; cannot build UI mock data.");
}

await writeFile(resolve(scriptDirectory, "../src/mock/data.json"), `${JSON.stringify(mockData, null, 2)}\n`, "utf8");
console.log(`Built mock data from Kingsyard fixtures (${mockData.skus.length} seed SKUs, ${mockData.generatedSkuCount} generated SKU slots).`);
