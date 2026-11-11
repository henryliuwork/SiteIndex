import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProfilePaths, profilePathsAreContained } from "./profile-path-diagnostic.js";

const temporaryRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-profile-paths-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile path diagnostics", () => {
  it("accepts actual Electron and environment paths under a clean isolated root", async () => {
    const root = await makeRoot();
    const appData = path.join(root, "profile", "roaming");
    const userData = path.join(appData, "SiteIndex");
    const paths = { appData, userData, APPDATA: appData, LOCALAPPDATA: path.join(root, "profile", "local") };
    await Promise.all(Object.values(paths).map((value) => mkdir(value, { recursive: true })));

    const diagnostics = await inspectProfilePaths(root, paths);

    expect(diagnostics).toEqual(
      Object.fromEntries(Object.keys(paths).map((key) => [key, { withinRoot: true, noReparse: true }])),
    );
    expect(profilePathsAreContained(diagnostics)).toBe(true);
  });

  it("rejects missing and outside paths without returning their values", async () => {
    const root = await makeRoot();
    const inside = path.join(root, "inside");
    await mkdir(inside);

    const diagnostics = await inspectProfilePaths(root, {
      appData: inside,
      userData: path.join(root, "missing"),
      APPDATA: path.dirname(root),
    });

    expect(diagnostics).toEqual({
      appData: { withinRoot: true, noReparse: true },
      userData: { withinRoot: false, noReparse: false },
      APPDATA: { withinRoot: false, noReparse: false },
    });
    expect(profilePathsAreContained(diagnostics)).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });

  it("rejects an ancestor junction that resolves outside the per-run root", async () => {
    const runnerTemp = await makeRoot();
    const root = path.join(runnerTemp, "profile-root");
    const outsideTarget = path.join(runnerTemp, "outside-target");
    const junction = path.join(root, "linked");
    await mkdir(root);
    await mkdir(outsideTarget);
    await writeFile(path.join(outsideTarget, "state.json"), "{}", "utf8");
    await symlink(outsideTarget, junction, "junction");

    const diagnostics = await inspectProfilePaths(root, { userData: path.join(junction, "state.json") });

    expect(diagnostics.userData?.withinRoot).toBe(false);
    if (process.platform === "win32") expect(diagnostics.userData?.noReparse).toBe(false);
    expect(profilePathsAreContained(diagnostics)).toBe(false);
  });
});
