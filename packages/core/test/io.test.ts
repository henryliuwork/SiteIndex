import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSV_HEADERS, EXIT, PATHS } from "@siteindex/shared";
import {
  assertRunner, atomicWrite, findConflictCopies, readCsv, readJsonl, readRunner,
  withLock, writeCsv, writeJsonl, writeRunner,
} from "../src";

const roots: string[] = [];
async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-io-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("core io", () => {
  it("serializes concurrent atomic writes without partial files", async () => {
    const root = await tempDir();
    const file = path.join(root, "nested", "output.txt");
    const values = Array.from({ length: 30 }, (_, i) => `${i}:` + "x".repeat(2048));
    await Promise.all(values.map((value) => atomicWrite(file, value)));
    expect(await readFile(file, "utf8")).toBe(values.at(-1));
    expect(await readdir(path.dirname(file))).toEqual(["output.txt"]);
  }, 20_000);

  it("writes JSONL in schema field and primary-key order, with a final LF", async () => {
    const root = await tempDir();
    const file = path.join(root, "rows.jsonl");
    await writeJsonl(file, [
      { sku: "b", title: "Second", custom: true },
      { sku: "A", title: "First", custom: false },
    ], "sku");
    expect(await readFile(file, "utf8")).toBe(
      '{"sku":"A","title":"First","custom":false}\n{"sku":"b","title":"Second","custom":true}\n',
    );
    expect((await readJsonl(file)).map((row) => row.sku)).toEqual(["A", "b"]);
  });

  it("keeps integer-valued schema numbers in Python float form", async () => {
    const root = await tempDir();
    const file = path.join(root, "prices.jsonl");
    await writeJsonl(file, [{ sku: "SKU-1", price: 39, compare_at_price: 40 }], "sku");
    expect(await readFile(file, "utf8")).toContain('"price":39.0,"compare_at_price":40.0');
  });

  it("matches Python CSV quoting, nulls, headers and key sorting", async () => {
    const root = await tempDir();
    const file = path.join(root, "summary.csv");
    await writeCsv(file, [
      { date: "2026-10-20", category: 'say "hi",\nthere', total: 2, in_stock: 1, out_of_stock: 0, preorder: null, unknown: 1 },
      { date: "2026-10-19", category: "_all", total: 1, in_stock: 1, out_of_stock: 0, preorder: 0, unknown: 0 },
    ], CSV_HEADERS.dailySummary, ["date", "category"]);
    expect(await readFile(file, "utf8")).toBe(
      'date,category,total,in_stock,out_of_stock,preorder,unknown\n2026-10-19,_all,1,1,0,0,0\n2026-10-20,"say ""hi"",\nthere",2,1,0,,1\n',
    );
    expect(await readCsv(file)).toEqual([
      { date: "2026-10-19", category: "_all", total: "1", in_stock: "1", out_of_stock: "0", preorder: "0", unknown: "0" },
      { date: "2026-10-20", category: 'say "hi",\nthere', total: "2", in_stock: "1", out_of_stock: "0", preorder: null, unknown: "1" },
    ]);
  });

  it("reads and writes the runner, and rejects scheduled work on another device", async () => {
    const root = await tempDir();
    await writeRunner(root, { device_id: "device-1", device_name: "Henry-PC", claimed_at: "2026-10-22T10:00:00Z" });
    expect(await readRunner(root)).toEqual({ device_id: "device-1", device_name: "Henry-PC", claimed_at: "2026-10-22T10:00:00Z" });
    await expect(assertRunner(root, "device-2", "schedule")).rejects.toMatchObject({ code: "NOT_RUNNER", exitCode: EXIT.NOT_RUNNER });
    await expect(assertRunner(root, "device-2", "manual")).resolves.toBeUndefined();
  });

  it("holds an exclusive lock, removes it after work, and reclaims stale locks", async () => {
    const root = await tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const running = withLock(root, async () => { started(); await gate; return "done"; }, { deviceId: "device-1", job: "daily", heartbeatMs: 60_000 });
    await entered;
    await expect(withLock(root, () => "never")).rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
    release();
    await expect(running).resolves.toBe("done");
    await expect(readFile(path.join(root, PATHS.lock), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(path.join(root, "index"), { recursive: true });
    await writeFile(path.join(root, PATHS.lock), JSON.stringify({ heartbeat: "2026-10-22T09:00:00.000Z" }));
    await expect(withLock(root, () => "recovered", {
      now: () => new Date("2026-10-22T10:00:00.000Z"), staleAfterMs: 60_000,
    })).resolves.toBe("recovered");
  });

  it("recognizes configured cloud conflict-copy names", async () => {
    const root = await tempDir();
    const index = path.join(root, "index");
    await mkdir(index);
    await writeFile(path.join(index, "skus (1).jsonl"), "");
    await writeFile(path.join(index, "catalog conflict.csv"), "");
    await writeFile(path.join(index, "latest.jsonl"), "");
    expect((await findConflictCopies(index)).map((file) => path.basename(file)).sort()).toEqual(["catalog conflict.csv", "skus (1).jsonl"]);
  });
});
