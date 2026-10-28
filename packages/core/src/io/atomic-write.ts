import { randomUUID } from "node:crypto";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

const writes = new Map<string, Promise<void>>();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  let created = false;
  try {
    handle = await open(temp, "wx");
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;

    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== "EPERM" && code !== "EBUSY") || attempt >= 10) throw error;
        await wait(200 * (attempt + 1));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** 同目录临时文件写入并 fsync 后替换目标；同进程并发写同一目标会串行完成。 */
export function atomicWrite(filePath: string, data: string | Uint8Array): Promise<void> {
  const target = path.resolve(filePath);
  const previous = writes.get(target) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => writeAtomic(target, data));
  writes.set(target, current);
  void current.then(
    () => { if (writes.get(target) === current) writes.delete(target); },
    () => { if (writes.get(target) === current) writes.delete(target); },
  );
  return current;
}
