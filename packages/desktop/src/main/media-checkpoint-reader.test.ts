import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStableBoundedFile } from "./media-checkpoint-reader.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "siteindex-checkpoint-reader-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stable bounded media checkpoint reads", () => {
  it("reads a regular checkpoint through a stable handle", async () => {
    const root = await temporaryRoot();
    const logs = path.join(root, "logs");
    const filePath = path.join(logs, "run.media.json");
    await mkdir(logs);
    await writeFile(filePath, "synthetic checkpoint", "utf8");

    await expect(readStableBoundedFile(filePath, 128, [root, logs])).resolves.toBe("synthetic checkpoint");
  });

  it("fails closed when the checked directory is replaced with a link before open", async () => {
    const root = await temporaryRoot();
    const logs = path.join(root, "logs");
    const replacementLogs = path.join(root, "replacement-logs");
    const filePath = path.join(logs, "run.media.json");
    await Promise.all([mkdir(logs), mkdir(replacementLogs)]);
    await writeFile(filePath, "expected file", "utf8");
    await writeFile(path.join(replacementLogs, "run.media.json"), "replacement file", "utf8");

    await expect(
      readStableBoundedFile(filePath, 128, [root, logs], {
        afterPathCheck: async () => {
          await rm(logs, { recursive: true });
          await symlink(replacementLogs, logs, process.platform === "win32" ? "junction" : "dir");
        },
      }),
    ).rejects.toThrow(/changed|identity|regular file/u);

    await expect(readFile(path.join(replacementLogs, "run.media.json"), "utf8")).resolves.toBe("replacement file");
  });

  it("caps the bytes read when the opened file grows after its initial handle stat", async () => {
    const root = await temporaryRoot();
    const logs = path.join(root, "logs");
    const filePath = path.join(logs, "run.media.json");
    await mkdir(logs);
    await writeFile(filePath, "small", "utf8");

    await expect(
      readStableBoundedFile(filePath, 64, [root, logs], {
        afterHandleStat: async () => appendFile(filePath, "x".repeat(1024), "utf8"),
      }),
    ).rejects.toThrow(/bounded-read|changed/u);
  });
});
