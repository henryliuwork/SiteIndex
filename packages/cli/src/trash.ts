import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function run(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || program + " exited with status " + String(code)));
    });
  });
}

async function moveAcrossDevices(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true });
  }
}

/** Move a folder to the operating system trash without adding a native dependency. */
export async function moveToTrash(folderPath: string): Promise<void> {
  const absolutePath = path.resolve(folderPath);
  if (process.platform === "win32") {
    const encodedPath = Buffer.from(absolutePath, "utf8").toString("base64");
    const script = "$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedPath + "')); Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)";
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    return;
  }

  if (process.platform === "darwin") {
    const script = "on run argv\n tell application \"Finder\" to delete POSIX file (item 1 of argv)\nend run";
    await run("/usr/bin/osascript", ["-e", script, absolutePath]);
    return;
  }

  if (process.platform === "linux") {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const trashRoot = path.join(dataHome, "Trash");
    const filesDir = path.join(trashRoot, "files");
    const infoDir = path.join(trashRoot, "info");
    const name = path.basename(absolutePath) + "-" + randomUUID();
    const destination = path.join(filesDir, name);
    const infoPath = path.join(infoDir, name + ".trashinfo");
    const deletionDate = new Date().toISOString().replace(/\.\d{3}Z$/, "");
    await mkdir(filesDir, { recursive: true });
    await mkdir(infoDir, { recursive: true });
    await writeFile(infoPath, "[Trash Info]\nPath=" + encodeURI(absolutePath) + "\nDeletionDate=" + deletionDate + "\n", { encoding: "utf8", flag: "wx" });
    try {
      await moveAcrossDevices(absolutePath, destination);
    } catch (error) {
      await rm(infoPath, { force: true });
      throw error;
    }
    return;
  }

  throw new Error("Unsupported trash platform: " + process.platform);
}