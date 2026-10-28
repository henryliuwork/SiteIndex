import { spawn } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSV_HEADERS, EXIT, PATHS } from "@siteindex/shared";
import {
  assertRunner, atomicWrite, findConflictCopies, readCsv, readJsonl, readRunner,
  withLock, writeCsv, writeJsonl, writeRunner,
} from "../src";
import { unlinkOwnedLock } from "../src/io/runner-lock";

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

  it("uses independent exclusive temp files for concurrent process writes", async () => {
    const root = await tempDir();
    const file = path.join(root, "nested", "output.txt");
    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const values = Array.from({ length: 8 }, (_, i) => String(i) + ":" + String(i).repeat(32_768));
    const childSource = [
      'import { atomicWrite } from "./src/io/atomic-write.ts";',
      'const target = process.env.SITEINDEX_ATOMIC_WRITE_TARGET;',
      'const value = process.env.SITEINDEX_ATOMIC_WRITE_VALUE;',
      'if (!target || value === undefined) throw new Error("Missing test parameters");',
      'await atomicWrite(target, value);',
    ].join("\n");

    const writeInChild = (value: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
        cwd: coreDirectory,
        env: {
          ...process.env,
          SITEINDEX_ATOMIC_WRITE_TARGET: file,
          SITEINDEX_ATOMIC_WRITE_VALUE: value,
        },
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error("atomicWrite child exited with code " + String(code) + " and signal " + String(signal)));
      });
    });

    await Promise.all(values.map(writeInChild));
    expect(values).toContain(await readFile(file, "utf8"));
    expect(await readdir(path.dirname(file))).toEqual(["output.txt"]);
  }, 30_000);

  it("cleans up its temporary file when a write fails", async () => {
    const root = await tempDir();
    const file = path.join(root, "nested", "output.txt");

    await expect(atomicWrite(file, null as unknown as string)).rejects.toBeDefined();
    expect(await readdir(path.dirname(file))).toEqual([]);
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
    await expect(readFile(path.join(root, PATHS.lock), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes locks for partial results and rejected callbacks", async () => {
    const root = await tempDir();
    await expect(withLock(root, () => ({ status: "partial" }), { heartbeatMs: 60_000 })).resolves.toEqual({ status: "partial" });
    await expect(readFile(path.join(root, PATHS.lock), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(withLock(root, () => { throw new Error("callback failed"); }, { heartbeatMs: 60_000 }))
      .rejects.toThrow("callback failed");
    await expect(readFile(path.join(root, PATHS.lock), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries an owned lock unlink after a transient Windows sharing error", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const record = { device_id: "device-1", device_name: "test", pid: process.pid, job: "weekly", started_at: "2026-10-28T00:00:00.000Z", heartbeat: "2026-10-28T00:00:00.000Z" };
    await writeFile(lockPath, JSON.stringify(record));
    const identity = await lstat(lockPath);
    let attempts = 0;
    await unlinkOwnedLock(lockPath, identity, { pid: record.pid, started_at: record.started_at }, {
      unlinkFile: async (filePath) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        await unlink(filePath);
      },
      wait: async () => undefined,
    });
    expect(attempts).toBe(2);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
