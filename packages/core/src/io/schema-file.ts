import { readFile } from "node:fs/promises";

/**
 * Load schema assets from source layout, a local flat CLI bundle, or a packaged
 * CLI whose schemas are placed beside resources/cli.js.
 */
export async function readSchemaFile(name: string, moduleUrl: string, sourceRelativePath: string): Promise<string> {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`无效 schema 名称: ${name}`);

  const filename = `${name}.schema.json`;
  const candidates = [
    new URL(`${sourceRelativePath}/${filename}`, moduleUrl),
    new URL(`./schemas/${filename}`, moduleUrl),
    new URL(`../../../schemas/${filename}`, moduleUrl),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      lastError = error;
    }
  }
  throw lastError;
}
