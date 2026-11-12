import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bypassPendingMediaGateForTestBundle, createMediaProductionUi } from "./media-production-ui.js";

const GATE =
  "function x(e,t=C){return t.includes(`media.prepare`)?{available:!1,message:`当前版本暂未开放图片准备功能。`}:typeof e.media?.prepare==`function`?{available:!0,message:``}:{available:!1,message:`当前桌面版暂未提供图片准备接口，不能执行图片处理。`}}";
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-media-ui-test-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("test-only EDM media UI resource", () => {
  it("bypasses exactly the pending UI capability check while retaining the API method check", () => {
    const output = bypassPendingMediaGateForTestBundle(GATE);
    expect(output).toContain(
      "return !1?{available:!1,message:`当前版本暂未开放图片准备功能。`}:typeof e.media?.prepare==`function`?",
    );
    expect(output).not.toContain("t.includes(`media.prepare`)");
  });

  it("fails closed when the compiled EDM capability shape is missing or duplicated", () => {
    expect(() => bypassPendingMediaGateForTestBundle("function x(){return true}")).toThrow("found 0");
    expect(() => bypassPendingMediaGateForTestBundle(`${GATE}${GATE}`)).toThrow("found 2");
  });

  it("copies the built UI into an isolated resource and leaves the production source unchanged", async () => {
    const parent = await createTemporaryDirectory();
    const source = path.join(parent, "build-resources", "ui");
    const destination = path.join(parent, "build-resources", "ui-media-e2e");
    await mkdir(path.join(source, "assets"), { recursive: true });
    await writeFile(path.join(source, "index.html"), "<html></html>");
    await writeFile(path.join(source, "assets", "EdmPage-fixture.js"), GATE);

    await createMediaProductionUi(source, destination);

    expect(await readFile(path.join(source, "assets", "EdmPage-fixture.js"), "utf8")).toBe(GATE);
    expect(await readFile(path.join(destination, "assets", "EdmPage-fixture.js"), "utf8")).toContain("return !1?");
    await expect(readFile(path.join(destination, "index.html"), "utf8")).resolves.toBe("<html></html>");
  });

  it("rejects any source or destination outside the reserved sibling build resources", async () => {
    await expect(createMediaProductionUi("C:/other/ui", "C:/other/ui-media-e2e")).rejects.toThrow("build resources");
  });
});
