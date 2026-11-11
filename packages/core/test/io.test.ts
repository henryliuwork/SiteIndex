import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSV_HEADERS, EXIT, PATHS, pathsFor } from "@siteindex/shared";
import {
  assertRunner, atomicWrite, findConflictCopies, readCsv, readJsonl, readRunner,
  withLock, writeCsv, writeJsonl, writeRunner,
} from "../src";
import { readOrCreateLocalHostId, unlinkOwnedLock, withLockForTest } from "../src/io/runner-lock";

const roots: string[] = [];
async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-io-"));
  roots.push(root);
  return root;
}

async function currentHostId(project: string): Promise<string> {
  let hostId = "";
  await withLock(project, async () => {
    const record = JSON.parse(await readFile(path.join(project, PATHS.lock), "utf8")) as { host_id: string };
    hostId = record.host_id;
  }, { heartbeatMs: 60_000 });
  return hostId;
}

function hostIdentityEnvironment(stateRoot: string): NodeJS.ProcessEnv {
  if (process.platform === "win32") return { LOCALAPPDATA: stateRoot };
  if (process.platform === "darwin") return { HOME: stateRoot };
  return { XDG_STATE_HOME: stateRoot };
}

function hostIdentityFile(stateRoot: string): string {
  if (process.platform === "win32") return path.join(stateRoot, "SiteIndex", "lock-host-id");
  if (process.platform === "darwin") return path.join(stateRoot, "Library", "Application Support", "SiteIndex", "lock-host-id");
  return path.join(stateRoot, "siteindex", "lock-host-id");
}

function runChildScript(source: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `Lock identity child exited (${String(code)} / ${String(signal)})`));
    });
  });
}

function waitForMarker(markerPath: string, timeoutMs = 10_000): Promise<string> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        resolve(await readFile(markerPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          reject(error);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for process marker: ${path.basename(markerPath)}`));
          return;
        }
        setTimeout(() => { void check(); }, 5);
      }
    };
    void check();
  });
}

function runBarrierChildScripts(sources: readonly string[], cwd: string, envs: readonly NodeJS.ProcessEnv[]): Promise<string[]> {
  const children = sources.map((source, index) => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd, env: envs[index], stdio: ["pipe", "pipe", "pipe"],
  }));
  const output = children.map(() => "");
  const errors = children.map(() => "");
  const ready = children.map((child, index) => new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output[index] = `${output[index] ?? ""}${chunk.toString("utf8")}`;
      if ((output[index] ?? "").includes("READY\n")) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => { errors[index] = `${errors[index] ?? ""}${chunk.toString("utf8")}`; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!(output[index] ?? "").includes("READY\n")) {
        reject(new Error(errors[index] || `Lock identity child exited before ready (${String(code)} / ${String(signal)})`));
      }
    });
  }));
  const completed = children.map((child, index) => new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(output[index]!.replace(/^READY\n/, "").trim());
      else reject(new Error(errors[index] || `Lock identity child exited (${String(code)} / ${String(signal)})`));
    });
  }));

  return (async () => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(ready),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Lock identity children did not reach the test barrier")), 15_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      for (const child of children) child.stdin?.end("go\n");
      return await Promise.all(completed);
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      for (const child of children) child.kill();
      throw error;
    }
  })();
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

  it("stores runner state and execution locks in the workspace data directory", async () => {
    const root = await tempDir();
    const paths = pathsFor("workspace");
    await mkdir(path.join(root, paths.index), { recursive: true });
    await writeFile(path.join(root, paths.site), "{}\n", "utf8");
    const runner = { device_id: "device-workspace", device_name: "test", claimed_at: "2026-10-22T10:00:00Z" };

    await writeRunner(root, runner);
    expect(await readFile(path.join(root, paths.runner), "utf8")).toContain(runner.device_id);
    expect(await readRunner(root)).toEqual(runner);
    await expect(readFile(path.join(root, PATHS.runner))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(withLock(root, async () => {
      expect(await readFile(path.join(root, paths.lock), "utf8")).toContain('"device_id":"device-workspace"');
      await expect(readFile(path.join(root, PATHS.lock))).rejects.toMatchObject({ code: "ENOENT" });
      return "locked";
    }, { deviceId: runner.device_id, heartbeatMs: 60_000 })).resolves.toBe("locked");
    await expect(readFile(path.join(root, paths.lock))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds an exclusive lock and fails closed on a stale lock with unknown ownership", async () => {
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
    const staleLegacyLock = JSON.stringify({ heartbeat: "2026-10-22T09:00:00.000Z" });
    await writeFile(path.join(root, PATHS.lock), staleLegacyLock);
    await expect(withLock(root, () => "must not enter"))
      .rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
    await expect(readFile(path.join(root, PATHS.lock), "utf8")).resolves.toBe(staleLegacyLock);
  });

  it("treats incomplete stale lock records as unknown ownership and preserves them", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "");

    await expect(withLock(root, () => "must not enter")).rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });

    const staleAt = new Date("2026-10-22T09:00:00.000Z");
    await utimes(lockPath, staleAt, staleAt);
    await expect(withLock(root, () => "must not enter"))
      .rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  });

  it("does not steal a stale local lock when its owner PID is still alive", async () => {
    const root = await tempDir();
    const hostId = await currentHostId(root);
    const lockPath = path.join(root, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const record = {
      device_id: "live-owner",
      device_name: "test",
      host_id: hostId,
      pid: process.pid,
      job: "synthetic-stalled-job",
      started_at: "2026-10-22T09:00:00.000Z",
      heartbeat: "2026-10-22T09:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(record));

    await expect(withLock(root, () => "must not enter"))
      .rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(record));
  });

  it.each([
    ["a reused PID that now belongs to another live process", undefined],
    ["a PID that cannot be probed due to EPERM", "EPERM"],
  ])("fails closed for %s", async (_description, probeFailure) => {
    const root = await tempDir();
    const hostId = await currentHostId(root);
    const lockPath = path.join(root, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const record = {
      device_id: "same-host-owner",
      device_name: "test",
      host_id: hostId,
      pid: 424242,
      job: "daily",
      started_at: "2026-10-22T09:00:00.000Z",
      heartbeat: "2000-01-01T00:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(record));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      if (probeFailure) throw Object.assign(new Error("probe denied"), { code: probeFailure });
      return true;
    });

    try {
      await expect(withLock(root, () => "must not enter"))
        .rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
      await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(record));
    } finally {
      kill.mockRestore();
    }
  });

  it("never reclaims remote or legacy locks even when their heartbeat is stale", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const remote = {
      device_id: "remote-owner",
      device_name: "test",
      host_id: "a1b2c3d4-1111-4111-8111-111111111111",
      pid: Number.MAX_SAFE_INTEGER,
      job: "daily",
      started_at: "2026-10-22T09:00:00.000Z",
      heartbeat: "2026-10-22T09:00:00.000Z",
    };
    await writeFile(lockPath, JSON.stringify(remote));
    await expect(withLock(root, () => "must not enter"))
      .rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(remote));

    const legacy: Record<string, unknown> = { ...remote, heartbeat: "2000-01-01T00:00:00.000Z" };
    delete legacy.host_id;
    await writeFile(lockPath, JSON.stringify(legacy));
    await expect(withLock(root, () => "must not enter"))
      .rejects.toMatchObject({ code: "LOCKED", exitCode: EXIT.LOCKED });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(legacy));
  });

  it("publishes one complete host identity with a deterministic two-process publication barrier", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostFile = hostIdentityFile(stateRoot);
    const publicationBarrier = path.join(root, "host-id-publication-barrier");
    await mkdir(publicationBarrier, { recursive: true });
    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const source = [
      'import { readFile, readdir, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      'import { readOrCreateLocalHostId } from "./src/io/runner-lock.ts";',
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'const lockFile = process.env.SITEINDEX_TEST_LOCK_FILE;',
      'const hostFile = process.env.SITEINDEX_TEST_HOST_FILE;',
      'const barrier = process.env.SITEINDEX_TEST_HOST_BARRIER;',
      'if (!root || !lockFile || !hostFile || !barrier) throw new Error("Missing test parameters");',
      'process.stdout.write("READY\\n");',
      'await new Promise((resolve) => process.stdin.once("data", resolve));',
      'const hostId = await readOrCreateLocalHostId(hostFile, { beforePublish: async () => {',
      '  await writeFile(path.join(barrier, `${process.pid}.ready`), "ready", { flag: "wx" });',
      '  while ((await readdir(barrier)).filter((name) => name.endsWith(".ready")).length < 2) await new Promise((resolve) => setTimeout(resolve, 5));',
      '} });',
      'await withLock(root, async () => { const lock = JSON.parse(await readFile(lockFile, "utf8")); if (lock.host_id !== hostId) throw new Error("Lock used a different host identity"); process.stdout.write(lock.host_id); }, { heartbeatMs: 60000 });',
      'if (hostId.length !== 36) throw new Error("Host identity was not a UUID");',
    ].join("\n");
    const hostEnv = hostIdentityEnvironment(stateRoot);
    const childEnvs = Array.from({ length: 2 }, (_, index) => {
      const project = path.join(root, `parallel-project-${index}`);
      return {
        ...process.env,
        ...hostEnv,
        SITEINDEX_TEST_HOST_FILE: hostFile,
        SITEINDEX_TEST_HOST_BARRIER: publicationBarrier,
        SITEINDEX_TEST_LOCK_ROOT: project,
        SITEINDEX_TEST_LOCK_FILE: path.join(project, PATHS.lock),
      };
    });

    const hostIds = await runBarrierChildScripts([source, source], coreDirectory, childEnvs);

    expect(new Set(hostIds).size).toBe(1);
    expect(hostIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await readFile(hostFile, "utf8")).toBe(`${hostIds[0]}\n`);
    expect((await readdir(path.dirname(hostFile))).sort()).toEqual(["lock-host-id"]);
    expect((await readdir(publicationBarrier)).filter((name) => name.endsWith(".ready"))).toHaveLength(2);
  }, 30_000);

  it("recovers safely from crashes before and after host identity publication", async () => {
    const root = await tempDir();
    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const beforePath = path.join(root, "before-publish", "lock-host-id");
    await mkdir(path.dirname(beforePath), { recursive: true });
    const beforeSource = [
      'import { readOrCreateLocalHostId } from "./src/io/runner-lock.ts";',
      'await readOrCreateLocalHostId(process.env.SITEINDEX_TEST_HOST_FILE, { beforePublish: async () => process.exit(71) });',
    ].join("\n");

    await expect(runChildScript(beforeSource, coreDirectory, { ...process.env, SITEINDEX_TEST_HOST_FILE: beforePath }))
      .rejects.toThrow(/Lock identity child exited \(71 \/ null\)/);
    await expect(readFile(beforePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.dirname(beforePath))).toEqual(expect.arrayContaining([expect.stringMatching(/^\.lock-host-id\.tmp-/)]));

    const beforeRecovery = await readOrCreateLocalHostId(beforePath);
    expect(beforeRecovery).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(readFile(beforePath, "utf8")).resolves.toBe(`${beforeRecovery}\n`);

    const afterPath = path.join(root, "after-publish", "lock-host-id");
    await mkdir(path.dirname(afterPath), { recursive: true });
    const afterSource = [
      'import { readOrCreateLocalHostId } from "./src/io/runner-lock.ts";',
      'await readOrCreateLocalHostId(process.env.SITEINDEX_TEST_HOST_FILE, { afterPublish: async () => process.exit(72) });',
    ].join("\n");

    await expect(runChildScript(afterSource, coreDirectory, { ...process.env, SITEINDEX_TEST_HOST_FILE: afterPath }))
      .rejects.toThrow(/Lock identity child exited \(72 \/ null\)/);
    const afterPublished = (await readFile(afterPath, "utf8")).trim();
    expect(afterPublished).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(readOrCreateLocalHostId(afterPath)).resolves.toBe(afterPublished);
    await expect(readFile(afterPath, "utf8")).resolves.toBe(`${afterPublished}\n`);
  }, 30_000);

  it("fails closed on a partial local identity left by a crash and documents safe reset behavior", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostIdPath = hostIdentityFile(stateRoot);
    const lockRoot = path.join(root, "project");
    const lockPath = path.join(lockRoot, PATHS.lock);
    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const source = [
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing lock root");',
      'try { await withLock(root, () => "acquired", { heartbeatMs: 60000 }); process.stdout.write("acquired"); }',
      'catch (error) { const value = error && typeof error === "object" ? error : {}; process.stdout.write(`${value.code ?? "ERROR"}:${value.message ?? String(error)}`); }',
    ].join("\n");
    const env = {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: lockRoot,
    };
    await mkdir(path.dirname(hostIdPath), { recursive: true });
    await writeFile(hostIdPath, "partial UUID");

    const invalid = await runChildScript(source, coreDirectory, env);

    expect(invalid).toContain("LOCKED:");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Recovery requires confirming this local user has no running SiteIndex process, then removing
    // only the corrupt local identity file; old project locks remain unknown and are never auto-stolen.
    await rm(hostIdPath);
    const recovered = await runChildScript(source, coreDirectory, env);

    expect(recovered).toBe("acquired");
    const lockId = (await readFile(hostIdentityFile(stateRoot), "utf8")).trim();
    expect(lockId).toMatch(/^[0-9a-f-]{36}$/i);
  }, 30_000);

  it("immediately reclaims a fresh lock after its owning child process exits", async () => {
    const root = await tempDir();
    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const childSource = [
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing lock root");',
      'await withLock(root, async () => { process.stdout.write("held\\n"); await new Promise(() => undefined); }, { deviceId: "child", job: "daily", heartbeatMs: 60_000 });',
    ].join("\n");
    let child: ReturnType<typeof spawn> | undefined;
    let closed!: () => void;
    const childClosed = new Promise<void>((resolve) => { closed = resolve; });
    try {
      child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
        cwd: coreDirectory,
        env: { ...process.env, SITEINDEX_TEST_LOCK_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let signalReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { signalReady = resolve; rejectReady = reject; });
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("held\n")) signalReady();
      });
      child.once("error", rejectReady);
      child.once("close", () => closed());
      let readyTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => { readyTimeout = setTimeout(() => reject(new Error("child did not acquire project lock")), 10_000); }),
        ]);
      } finally {
        if (readyTimeout) clearTimeout(readyTimeout);
      }

      const lockPath = path.join(root, PATHS.lock);
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as { host_id: string; pid: number; heartbeat: string };
      expect(lock.host_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(lock.pid).toBe(child.pid);
      expect(Date.now() - Date.parse(lock.heartbeat)).toBeLessThan(5_000);
      child.kill();
      await childClosed;
      child = undefined;

      await expect(withLock(root, () => "recovered immediately", { heartbeatMs: 60_000 })).resolves.toBe("recovered immediately");
      await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await childClosed;
      }
    }
  }, 30_000);

  it("allows only one stale-lock reclaimer into the critical section", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const markerDir = path.join(root, "markers");
    await mkdir(markerDir, { recursive: true });
    const env = {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: path.join(root, "project"),
      SITEINDEX_TEST_MARKER_DIR: markerDir,
    };
    const ownerSource = [
      'import { writeFile } from "node:fs/promises";',
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'const markers = process.env.SITEINDEX_TEST_MARKER_DIR;',
      'if (!root || !markers) throw new Error("Missing test parameters");',
      'await withLock(root, async () => {',
      '  await writeFile(`${markers}/owner.entered`, "entered");',
      '  setInterval(() => undefined, 1000);',
      '  await new Promise(() => undefined);',
      '}, { heartbeatMs: 60000 });',
    ].join("\n");
    const reclaimerSource = [
      'import { readFile, writeFile } from "node:fs/promises";',
      'import { withLockForTest } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'const markers = process.env.SITEINDEX_TEST_MARKER_DIR;',
      'const role = process.env.SITEINDEX_TEST_ROLE;',
      'if (!root || !markers || !role) throw new Error("Missing test parameters");',
      'const wait = async (name) => { while (true) { try { await readFile(`${markers}/${name}`, "utf8"); return; } catch (error) { if (error?.code !== "ENOENT") throw error; await new Promise((resolve) => setTimeout(resolve, 5)); } } };',
      'try {',
      '  await withLockForTest(root, async () => {',
      '    await writeFile(`${markers}/${role}.entered`, "entered");',
      '    await wait(`${role}.finish`);',
      '  }, { job: "daily", heartbeatMs: 60000 }, {',
      '    afterStaleLockValidated: async () => {',
      '      await writeFile(`${markers}/${role}.validated`, "validated");',
      '      await wait(`${role}.continue`);',
      '    },',
      '  });',
      '  await writeFile(`${markers}/${role}.result`, "acquired");',
      '} catch (error) {',
      '  const value = error && typeof error === "object" ? error : {};',
      '  await writeFile(`${markers}/${role}.result`, `${value.code ?? "ERROR"}:${value.message ?? String(error)}`);',
      '}',
    ].join("\n");
    const startChild = (source: string, role?: string) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
        cwd: coreDirectory,
        env: { ...env, ...(role ? { SITEINDEX_TEST_ROLE: role } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const closed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0 || signal !== null) resolve();
          else reject(new Error(stderr || output || `Lock race child exited with code ${String(code)}`));
        });
      });
      return { child, closed };
    };
    const owner = startChild(ownerSource);
    let workers: Array<ReturnType<typeof startChild>> = [];
    try {
      await waitForMarker(path.join(markerDir, "owner.entered"));
      owner.child.kill();
      await owner.closed;

      const first = startChild(reclaimerSource, "a");
      workers.push(first);
      await waitForMarker(path.join(markerDir, "a.validated"));
      const second = startChild(reclaimerSource, "b");
      workers.push(second);
      const secondResult = await waitForMarker(path.join(markerDir, "b.result"));
      expect(secondResult).toMatch(/^LOCKED:/);
      await expect(readFile(path.join(markerDir, "b.entered"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(path.join(markerDir, "a.continue"), "go");
      await waitForMarker(path.join(markerDir, "a.entered"));
      await writeFile(path.join(markerDir, "a.finish"), "go");
      await Promise.all(workers.map((process) => process.closed));
      expect(await readFile(path.join(markerDir, "a.result"), "utf8")).toBe("acquired");

      const retry = startChild(reclaimerSource, "retry");
      workers.push(retry);
      await waitForMarker(path.join(markerDir, "retry.entered"));
      await writeFile(path.join(markerDir, "retry.finish"), "go");
      await retry.closed;
      expect(await readFile(path.join(markerDir, "retry.result"), "utf8")).toBe("acquired");
    } finally {
      await writeFile(path.join(markerDir, "a.continue"), "go").catch(() => undefined);
      await writeFile(path.join(markerDir, "b.continue"), "go").catch(() => undefined);
      await writeFile(path.join(markerDir, "a.finish"), "go").catch(() => undefined);
      await writeFile(path.join(markerDir, "b.finish"), "go").catch(() => undefined);
      await writeFile(path.join(markerDir, "retry.finish"), "go").catch(() => undefined);
      owner.child.kill();
      for (const process of workers) process.child.kill();
      await Promise.all([owner.closed, ...workers.map((process) => process.closed)]).catch(() => undefined);
    }
  }, 30_000);

  it("retries stale-lock recovery in the same process after one rename failure", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, PATHS.lock);
    const hostId = await currentHostId(root);
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    const now = new Date().toISOString();
    await writeFile(lockPath, `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: now,
      heartbeat: now,
    })}\n`);
    const injected = Object.assign(new Error("injected transient rename failure"), { code: "EPERM" });

    await expect(withLockForTest(root, () => "must not enter", { heartbeatMs: 60_000 }, {
      renameStaleLock: async () => { throw injected; },
    })).rejects.toMatchObject({ code: "EPERM" });
    await expect(withLock(root, () => "recovered on same-process retry", { heartbeatMs: 60_000 }))
      .resolves.toBe("recovered on same-process retry");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not steal an active same-process claim and retries after a release marker write failure", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, PATHS.lock);
    const hostId = await currentHostId(root);
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    const staleLock = `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
    })}\n`;
    await writeFile(lockPath, staleLock);

    let published!: () => void;
    const claimPublished = new Promise<void>((resolve) => { published = resolve; });
    let continueFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { continueFirst = resolve; });
    let failStateLink = true;
    const renameFailure = Object.assign(new Error("injected transient rename failure"), { code: "EPERM" });
    const stateWriteFailure = Object.assign(new Error("injected local-state write failure"), { code: "ENOSPC" });

    const firstAttempt = withLockForTest(root, () => "must not enter", { heartbeatMs: 60_000 }, {
      afterReclaimClaimPublished: async () => { published(); await firstGate; },
      renameStaleLock: async () => { throw renameFailure; },
      linkReclaimClaimState: async (tempPath, statePath) => {
        if (failStateLink) {
          failStateLink = false;
          throw stateWriteFailure;
        }
        await link(tempPath, statePath);
      },
    });
    await claimPublished;
    await expect(withLock(root, () => "must not steal active same-process claim", { heartbeatMs: 60_000 }))
      .rejects.toMatchObject({ code: "LOCKED" });

    continueFirst();
    await expect(firstAttempt).rejects.toMatchObject({ code: "LOCKED" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(staleLock);
    await expect(withLock(root, () => "recovered after local state returned", { heartbeatMs: 60_000 }))
      .resolves.toBe("recovered after local state returned");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("recovers after a stale-lock reclaimer crashes after publishing its claim", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostIdPath = hostIdentityFile(stateRoot);
    const hostId = await readOrCreateLocalHostId(hostIdPath);
    const project = path.join(root, "project");
    const lockPath = path.join(project, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    expect(exitedPid).toBeGreaterThan(0);
    const now = new Date().toISOString();
    await writeFile(lockPath, `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: now,
      heartbeat: now,
    })}\n`);

    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const crashSource = [
      'import { withLockForTest } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'await withLockForTest(root, () => "must not enter", { heartbeatMs: 60000 }, {',
      '  afterReclaimClaimPublished: async () => process.exit(73),',
      '});',
    ].join("\n");
    await expect(runChildScript(crashSource, coreDirectory, {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    })).rejects.toThrow(/Lock identity child exited \(73 \/ null\)/);

    const recoverSource = [
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'await withLock(root, () => "recovered", { heartbeatMs: 60000 }).then((value) => process.stdout.write(value));',
    ].join("\n");
    await expect(runChildScript(recoverSource, coreDirectory, {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    })).resolves.toBe("recovered");
    const claimFiles = await readdir(path.join(path.dirname(hostIdPath), "lock-recovery"));
    expect(claimFiles.some((name) => name.endsWith(".root"))).toBe(true);
    expect(claimFiles.some((name) => name.endsWith(".state"))).toBe(true);
  }, 30_000);

  it("rejects a claim path replacement between handle read and path identity check", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostIdPath = hostIdentityFile(stateRoot);
    const hostId = await readOrCreateLocalHostId(hostIdPath);
    const project = path.join(root, "project");
    const lockPath = path.join(project, PATHS.lock);
    const markerDir = path.join(root, "markers");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await mkdir(markerDir, { recursive: true });
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    const now = new Date().toISOString();
    const staleLock = `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: now,
      heartbeat: now,
    })}\n`;
    await writeFile(lockPath, staleLock);

    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const crashSource = [
      'import { withLockForTest } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'await withLockForTest(root, () => "must not enter", { heartbeatMs: 60000 }, {',
      '  afterReclaimClaimPublished: async () => process.exit(75),',
      '});',
    ].join("\n");
    await expect(runChildScript(crashSource, coreDirectory, {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    })).rejects.toThrow(/Lock identity child exited \(75 \/ null\)/);

    const recoveryDirectory = path.join(path.dirname(hostIdPath), "lock-recovery");
    const rootName = (await readdir(recoveryDirectory)).find((name) => name.endsWith(".root"));
    expect(rootName).toBeDefined();
    const rootClaimPath = path.join(recoveryDirectory, rootName!);
    const oldClaim = JSON.parse(await readFile(rootClaimPath, "utf8")) as {
      host_id: string; pid: number; token: string; lock_key: string; previous_token: string | null;
    };
    const replacementTemp = `${rootClaimPath}.replacement-${randomUUID()}`;
    const readMarker = path.join(markerDir, "claim-read");
    const continueMarker = path.join(markerDir, "continue");
    const resultMarker = path.join(markerDir, "result");
    const source = [
      'import { readFile, writeFile } from "node:fs/promises";',
      'import { withLockForTest } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'const markers = process.env.SITEINDEX_TEST_MARKER_DIR;',
      'if (!root || !markers) throw new Error("Missing test parameters");',
      'const wait = async (name) => { while (true) { try { await readFile(`${markers}/${name}`, "utf8"); return; } catch (error) { if (error?.code !== "ENOENT") throw error; await new Promise((resolve) => setTimeout(resolve, 5)); } } };',
      'try {',
      '  await withLockForTest(root, () => "must not enter", { heartbeatMs: 60000 }, {',
      '    afterReclaimClaimReadBeforePathCheck: async () => { await writeFile(`${markers}/claim-read`, "ready"); await wait("continue"); },',
      '  });',
      '  await writeFile(`${markers}/result`, "ACQUIRED");',
      '} catch (error) { const value = error && typeof error === "object" ? error : {}; await writeFile(`${markers}/result`, `${value.code ?? "ERROR"}:${value.message ?? String(error)}`); }',
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: coreDirectory,
      env: {
        ...process.env,
        ...hostIdentityEnvironment(stateRoot),
        SITEINDEX_TEST_LOCK_ROOT: project,
        SITEINDEX_TEST_MARKER_DIR: markerDir,
      },
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Claim reader exited with ${String(code)}`)));
    });
    try {
      await waitForMarker(readMarker);
      await unlink(rootClaimPath);
      await writeFile(replacementTemp, `${JSON.stringify({
        version: 1,
        host_id: oldClaim.host_id,
        pid: process.pid,
        token: randomUUID(),
        lock_key: oldClaim.lock_key,
        previous_token: null,
      })}\n`, { flag: "wx" });
      await link(replacementTemp, rootClaimPath);
      await writeFile(continueMarker, "go");
      await closed;
      expect(await readFile(resultMarker, "utf8")).toMatch(/^LOCKED:/);
      const obsoleteSuccessor = path.join(recoveryDirectory, `${oldClaim.lock_key}.${oldClaim.token}`);
      await expect(lstat(obsoleteSuccessor)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(lockPath, "utf8")).resolves.toBe(staleLock);
    } finally {
      await writeFile(continueMarker, "go").catch(() => undefined);
      if (child.exitCode === null) child.kill();
      await closed.catch(() => undefined);
    }
  }, 30_000);

  it("fails closed when a previous stale-lock reclaim claim is malformed", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostIdPath = hostIdentityFile(stateRoot);
    const hostId = await readOrCreateLocalHostId(hostIdPath);
    const project = path.join(root, "project");
    const lockPath = path.join(project, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    const now = new Date().toISOString();
    const staleLock = `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: now,
      heartbeat: now,
    })}\n`;
    await writeFile(lockPath, staleLock);

    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const crashSource = [
      'import { withLockForTest } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'await withLockForTest(root, () => "must not enter", { heartbeatMs: 60000 }, {',
      '  afterReclaimClaimPublished: async () => process.exit(74),',
      '});',
    ].join("\n");
    await expect(runChildScript(crashSource, coreDirectory, {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    })).rejects.toThrow(/Lock identity child exited \(74 \/ null\)/);

    const recoveryDirectory = path.join(path.dirname(hostIdPath), "lock-recovery");
    const rootClaim = (await readdir(recoveryDirectory)).find((name) => name.endsWith(".root"));
    expect(rootClaim).toBeDefined();
    await writeFile(path.join(recoveryDirectory, rootClaim!), "{partial");
    const attemptSource = [
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'try { await withLock(root, () => "must not enter", { heartbeatMs: 60000 }); }',
      'catch (error) { const value = error && typeof error === "object" ? error : {}; process.stdout.write(`${value.code ?? "ERROR"}:${value.message ?? String(error)}`); }',
    ].join("\n");
    await expect(runChildScript(attemptSource, coreDirectory, {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    })).resolves.toMatch(/^LOCKED:/);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(staleLock);
  }, 30_000);

  it("fails closed at 1024 reclaim generations and recovers after offline local-state reset", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostIdPath = hostIdentityFile(stateRoot);
    const hostId = await readOrCreateLocalHostId(hostIdPath);
    const project = path.join(root, "project");
    const lockPath = path.join(project, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    const staleLock = `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
    })}\n`;
    await writeFile(lockPath, staleLock);
    const lockIdentity = await lstat(lockPath);
    const lockKey = createHash("sha256")
      .update(`${await realpath(lockPath)}\0${lockIdentity.dev}:${lockIdentity.ino}:${lockIdentity.size}:${lockIdentity.mtimeMs}:${lockIdentity.ctimeMs}\0${staleLock}`)
      .digest("hex");
    const recoveryDirectory = path.join(path.dirname(hostIdPath), "lock-recovery");
    await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 });
    let previousToken: string | null = null;
    for (let generation = 0; generation < 1024; generation += 1) {
      const token = randomUUID();
      const claimPath = path.join(recoveryDirectory, generation === 0
        ? `${lockKey}.root`
        : `${lockKey}.${previousToken}`);
      await writeFile(claimPath, `${JSON.stringify({
        version: 1,
        host_id: hostId,
        pid: exitedPid,
        token,
        lock_key: lockKey,
        previous_token: previousToken,
      })}\n`, { flag: "wx", mode: 0o600 });
      previousToken = token;
    }

    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const attemptSource = [
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'try { const value = await withLock(root, () => "must not enter", { heartbeatMs: 60000 }); process.stdout.write(value); }',
      'catch (error) { const value = error && typeof error === "object" ? error : {}; process.stdout.write(`${value.code ?? "ERROR"}:${value.message ?? String(error)}`); }',
    ].join("\n");
    const env = {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    };
    await expect(runChildScript(attemptSource, coreDirectory, env)).resolves.toMatch(/^LOCKED:.*历史过长/);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(staleLock);

    // This isolated test models the documented reset: all SiteIndex processes are stopped,
    // then only per-user recovery metadata is cleared; project files are untouched.
    await rm(recoveryDirectory, { recursive: true, force: true });
    const recoveredSource = attemptSource.replace('() => "must not enter"', '() => "recovered"');
    await expect(runChildScript(recoveredSource, coreDirectory, env)).resolves.toBe("recovered");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("returns a structured LOCKED error when the local reclaim directory is unavailable", async () => {
    const root = await tempDir();
    const stateRoot = path.join(root, "isolated-local-state");
    const hostIdPath = hostIdentityFile(stateRoot);
    const hostId = await readOrCreateLocalHostId(hostIdPath);
    const project = path.join(root, "project");
    const lockPath = path.join(project, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const exitedPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", () => resolve(child.pid ?? 0));
    });
    const now = new Date().toISOString();
    const staleLock = `${JSON.stringify({
      device_id: "fixture-device",
      device_name: "Fixture",
      host_id: hostId,
      pid: exitedPid,
      job: "daily",
      started_at: now,
      heartbeat: now,
    })}\n`;
    await writeFile(lockPath, staleLock);
    await writeFile(path.join(path.dirname(hostIdPath), "lock-recovery"), "not a directory");

    const coreDirectory = path.resolve(process.cwd(), "packages/core");
    const attemptSource = [
      'import { withLock } from "./src/io/runner-lock.ts";',
      'const root = process.env.SITEINDEX_TEST_LOCK_ROOT;',
      'if (!root) throw new Error("Missing project path");',
      'try { await withLock(root, () => "must not enter", { heartbeatMs: 60000 }); }',
      'catch (error) { const value = error && typeof error === "object" ? error : {}; process.stdout.write(`${value.code ?? "ERROR"}:${value.message ?? String(error)}`); }',
    ].join("\n");
    await expect(runChildScript(attemptSource, coreDirectory, {
      ...process.env,
      ...hostIdentityEnvironment(stateRoot),
      SITEINDEX_TEST_LOCK_ROOT: project,
    })).resolves.toMatch(/^LOCKED:/);
    await expect(readFile(lockPath, "utf8")).resolves.toBe(staleLock);
  }, 30_000);

  it("handles 200 concurrent lock attempts without exposing partial JSON", async () => {
    const root = await tempDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const attempts = Array.from({ length: 200 }, () => withLock(root, async () => {
      started();
      await gate;
      return "owner";
    }, { heartbeatMs: 2 }));
    const settledAttempts = Promise.allSettled(attempts);

    await entered;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    release();
    const results = await settledAttempts;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(199);
    expect(rejected.every((result) => !(result.reason instanceof SyntaxError))).toBe(true);
    expect(rejected.every((result) => typeof result.reason === "object" && result.reason !== null
      && "code" in result.reason && result.reason.code === "LOCKED")).toBe(true);

    const lockPath = path.join(root, PATHS.lock);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "{\"heartbeat\":", "utf8");
    const malformedAttempts = await Promise.allSettled(
      Array.from({ length: 200 }, () => withLock(root, () => "must not enter")),
    );
    expect(malformedAttempts.every((result) => result.status === "rejected")).toBe(true);
    expect(malformedAttempts.every((result) => result.status === "rejected"
      && !(result.reason instanceof SyntaxError)
      && typeof result.reason === "object" && result.reason !== null
      && "code" in result.reason && result.reason.code === "LOCKED")).toBe(true);
  }, 20_000);

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
    const record = { device_id: "device-1", device_name: "test", host_id: await currentHostId(root), pid: process.pid, job: "weekly", started_at: "2026-10-28T00:00:00.000Z", heartbeat: "2026-10-28T00:00:00.000Z" };
    await writeFile(lockPath, JSON.stringify(record));
    const identity = await lstat(lockPath);
    let attempts = 0;
    await unlinkOwnedLock(lockPath, identity, { host_id: record.host_id, pid: record.pid, started_at: record.started_at }, {
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
