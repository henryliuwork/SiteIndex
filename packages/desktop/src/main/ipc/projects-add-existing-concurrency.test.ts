import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectSummary } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsStore } from "../settings-store.js";
import { createProjectsHandlers } from "./projects.js";
import type { IpcContext } from "./context.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("projects.addExisting concurrent registration", () => {
  it("preserves both projects when two independent folders are added concurrently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-add-existing-race-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects-root");
    const projectPaths = [path.join(root, "external", "first"), path.join(root, "external", "second")];
    await Promise.all([
      mkdir(projectsRoot, { recursive: true }),
      ...projectPaths.map((projectPath) => mkdir(projectPath, { recursive: true })),
    ]);
    const settings = createSettingsStore(path.join(root, "settings"), "Fixture Device");
    await settings.set({ projects_root: projectsRoot });

    let releaseFirstPath!: () => void;
    let signalFirstPath!: () => void;
    const firstPathStarted = new Promise<void>((resolve) => {
      signalFirstPath = resolve;
    });
    const firstPathGate = new Promise<void>((resolve) => {
      releaseFirstPath = resolve;
    });
    const projects = {
      resolveExistingPath: vi.fn(async (value: string) => {
        if (value === projectPaths[0]) {
          signalFirstPath();
          await firstPathGate;
        }
        return value;
      }),
      ensureProject: vi.fn(async (id: string) => ({
        id,
        path: projectPaths.find((item) => path.basename(item) === id)!,
      })),
      refresh: vi.fn(async () => undefined),
    };
    const core = {
      projects: {
        get: vi.fn(async (id: string) => ({ summary: { id } as ProjectSummary })),
      },
    };
    const context = {
      settings,
      settingsChanged: vi.fn(async () => undefined),
      projects,
      core,
      reconcileProjectScheduleInBackground: vi.fn(),
    } as unknown as IpcContext;

    const addExisting = createProjectsHandlers(context)["projects.addExisting"]!;
    const first = addExisting(projectPaths[0]!);
    await firstPathStarted;
    const second = addExisting(projectPaths[1]!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const concurrentPathChecks = projects.resolveExistingPath.mock.calls.length;
    releaseFirstPath();
    await Promise.all([first, second]);

    expect(concurrentPathChecks).toBe(1);
    expect((await settings.get()).extra_projects).toEqual(projectPaths);
  });
});
