import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCoreService } from "@siteindex/core";
import { PATHS, type AppSettings, type ProjectId } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiBridge } from "../../preload/api.js";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import { createIpcContext, type IpcDependencies } from "./context.js";
import { createIpcHandlerImplementations } from "./handlers.js";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), trashItem: vi.fn() },
}));

const temporaryRoots: string[] = [];

async function createSyntheticProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-desktop-todos-"));
  temporaryRoots.push(root);
  const projectPath = path.join(root, "fixture-project");
  const sitePath = path.join(projectPath, PATHS.site);
  const findingsPath = path.join(projectPath, PATHS.todos);
  await Promise.all([
    mkdir(path.dirname(sitePath), { recursive: true }),
    mkdir(path.dirname(findingsPath), { recursive: true }),
  ]);
  await writeFile(
    sitePath,
    `${JSON.stringify(
      {
        schema_version: "1.0",
        domain: "fixture.example.test",
        base_url: "https://fixture.example.test",
        platform: "custom",
        currency: "USD",
        locale: "en-US",
        timezone: "UTC",
        brand: { name: "Synthetic fixture" },
        crawl: { feed_url: [], sku_field: "id", category_depth: 1 },
        categories: { mode: "feed" },
        edm: { image_priority: ["feed", "manual"] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const timestamp = "2026-11-13T10:00:00.000Z";
  await writeFile(
    findingsPath,
    `${JSON.stringify({
      dedupe_key: "todo:v1:synthetic-desktop-roundtrip",
      rule_id: "synthetic.desktop_roundtrip",
      subject: { kind: "sku", key: "FIXTURE-SKU", label: "Synthetic SKU" },
      title: "Synthetic Todo IPC roundtrip",
      sources: [{ path: "skus", record_key: "FIXTURE-SKU", collected_at: timestamp }],
      first_seen_at: timestamp,
      last_seen_at: timestamp,
    })}\n`,
    "utf8",
  );
  return projectPath;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Todo Desktop IPC and preload roundtrip", () => {
  it("lists and updates a synthetic local project's status and note, then reads its history", async () => {
    const projectPath = await createSyntheticProject();
    const projectId = "fixture-project" as ProjectId;
    const core = createCoreService({
      resolveProject: (id) => {
        if (id !== projectId) throw new Error("synthetic-project-id-mismatch");
        return projectPath;
      },
      deviceId: "fixture-device-only-for-lock-metadata",
      cacheDir: path.join(path.dirname(projectPath), "cache"),
    });
    const settings = { get: vi.fn(async () => ({ projects_root: path.dirname(projectPath) }) as AppSettings) };
    const projects = {
      ensureProject: vi.fn(async (id: ProjectId) => {
        if (id !== projectId) throw { code: "PROJECT_NOT_FOUND", message: "合成项目不存在。" };
      }),
    };
    const context = createIpcContext({ core, settings, projects } as unknown as IpcDependencies);
    const registry = createHandlerRegistry(createIpcHandlerImplementations(context));
    const bridge = createApiBridge({
      invoke: async (channel, ...args) => {
        const handler = registry.get(channel);
        if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
        try {
          return await handler(...args);
        } catch (error) {
          throw serializeIpcError(error);
        }
      },
      listen: () => () => undefined,
    });

    const initial = await bridge.todos?.list(projectId);
    expect(initial?.items).toEqual([
      expect.objectContaining({
        finding: expect.objectContaining({ dedupe_key: "todo:v1:synthetic-desktop-roundtrip" }),
        state: expect.objectContaining({ status: "open", note: null }),
      }),
    ]);
    expect(projects.ensureProject).toHaveBeenCalledTimes(1);

    await bridge.todos?.update(projectId, {
      dedupe_key: "todo:v1:synthetic-desktop-roundtrip",
      status: "in_progress",
    });
    await bridge.todos?.update(projectId, {
      dedupe_key: "todo:v1:synthetic-desktop-roundtrip",
      note: "Synthetic local review note",
    });

    const updated = await bridge.todos?.list(projectId);
    expect(updated?.items[0]?.state).toMatchObject({ status: "in_progress", note: "Synthetic local review note" });
    const history = await bridge.todos?.history(projectId, "todo:v1:synthetic-desktop-roundtrip");
    expect(history?.map((entry) => entry.action)).toEqual(["status_changed", "note_changed"]);
    expect(projects.ensureProject).toHaveBeenCalledTimes(5);
  });
});
