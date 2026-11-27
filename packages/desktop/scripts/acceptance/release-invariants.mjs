import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isolatedEnvironment } from "./session.mjs";

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

export function assertFontEvidence(evidence) {
  if (!evidence.offline || evidence.fontFiles < 1 || evidence.externalRequests > 0
    || ["Geist Variable", "Source Han Sans SC"].some((name) => {
      const family = evidence.families?.[name];
      return !family?.localSource || !family.loaded || !family.check;
    })) {
    throw mismatch("Installed fonts were not fully available from local resources while offline");
  }
}

/** Uses the already-running packaged candidate page; the matrix runner owns its lifecycle. */
export async function verifyOfflineFonts(page, executable) {
  const fontRoot = path.join(path.dirname(executable), "resources", "fonts");
  const entries = await readdir(fontRoot, { recursive: true }).catch(() => []);
  const fontFiles = (await Promise.all(entries.filter((name) => /\.(?:woff2?|ttf|otf)$/iu.test(name))
    .map((name) => stat(path.join(fontRoot, name)).then((file) => file.isFile() && file.size > 0)))).filter(Boolean).length;
  const requests = [];
  const onRequest = (request) => {
    if (request.resourceType() === "font" || /\.(?:woff2?|ttf|otf)(?:[?#]|$)/iu.test(request.url())) {
      requests.push(new URL(request.url()).protocol);
    }
  };
  page.on("request", onRequest);
  let offline = false;
  try {
    await page.context().setOffline(true);
    offline = true;
    const families = await page.evaluate(async () => {
      const samples = { "Geist Variable": "SiteIndex", "Source Han Sans SC": "设置项目、库存与产品管理" };
      const sources = Object.fromEntries(Object.keys(samples).map((name) => [name, []]));
      for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const family = rule.style.getPropertyValue("font-family").trim().replace(/^['"]|['"]$/gu, "");
        if (!Object.hasOwn(sources, family)) continue;
        const src = rule.style.getPropertyValue("src");
        for (const match of src.matchAll(/url\(["']?([^"')]+)["']?\)/gu)) {
          sources[family].push(new URL(match[1], sheet.href || document.baseURI).protocol);
        }
      }
      const results = {};
      for (const [name, sample] of Object.entries(samples)) {
        const descriptor = `400 12px "${name}"`;
        const faces = await document.fonts.load(descriptor, sample);
        results[name] = { localSource: sources[name].length > 0
          && sources[name].every((protocol) => protocol === "file:" || protocol === "data:"),
        loaded: faces.length > 0 && faces.every((face) => face.status === "loaded"),
        check: document.fonts.check(descriptor, sample) };
      }
      return results;
    });
    const evidence = { offline, fontFiles, externalRequests: requests.filter((protocol) => protocol !== "file:").length,
      families };
    assertFontEvidence(evidence);
    return evidence;
  } finally {
    if (offline) await page.context().setOffline(false);
    page.off("request", onRequest);
  }
}

export function assertRunJobEvidence(evidence) {
  if (evidence.exitCode !== 0 || evidence.spawnError || !evidence.successfulViewsRun || !evidence.lockAbsent) {
    throw mismatch("Installed --run-job views did not finish and record a successful run");
  }
}

/** Invoked after the candidate UI has exited normally, using a second synthetic project. */
export async function verifyPackagedRunJob(executable, profile, projectDir) {
  const history = path.join(projectDir, "index", "logs", "runs.jsonl");
  const before = (await readFile(history, "utf8")).trim().split(/\r?\n/u).filter(Boolean).length;
  const result = spawnSync(executable, ["--run-job", projectDir, "views"], {
    cwd: profile.root, env: isolatedEnvironment(profile), encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  const rows = (await readFile(history, "utf8")).trim().split(/\r?\n/u).filter(Boolean)
    .slice(before).map((line) => JSON.parse(line));
  const absent = async (name) => stat(path.join(projectDir, name)).then(() => false, (error) => {
    if (error?.code === "ENOENT") return true;
    throw error;
  });
  const evidence = { exitCode: result.status, spawnError: Boolean(result.error),
    successfulViewsRun: rows.some((row) => row.job === "views" && row.status === "ok"),
    lockAbsent: await absent("index/.lock") && await absent("_site-index/.lock") };
  assertRunJobEvidence(evidence);
  return evidence;
}
