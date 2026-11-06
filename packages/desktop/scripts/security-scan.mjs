import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".ps1",
  ".text",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const defaultRules = [
  ["domain", /(?:https?:\/\/|www\.)[^\s<>()\]]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|shop|store|email|test)\b/gi],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  [
    "identifier",
    /\b(?:audience|connection|account|list|campaign|workspace)\s*(?:id)?\s*[:=]\s*[A-Z0-9_-]{4,}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,
  ],
  ["sku", /\b(?:sku|item\s*(?:code|number)|product\s*(?:code|number|sku))\s*[:#=]\s*["']?[A-Z0-9][A-Z0-9_-]{3,}\b/gi],
  ["sku", /\b[A-Z]{2,7}[-_][A-Z0-9][A-Z0-9_-]{2,}\b|\b[A-Z0-9]{8,}\b/g],
  ["article_slug", /\bslug\s*[:=]\s*["'`]?[^\s"'`,;]{4,}|\/(?:blog|posts?|articles?)\/[\w/-]{4,}/gi],
  ["color", /#[0-9a-f]{3,8}\b/gi],
  ["font", /\b(?:Arial|Inter|Roboto|Montserrat|Lato|Helvetica|Open Sans|Poppins|Geist(?: Mono)?)\b/gi],
  ["credential", /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]+/gi],
  ["credential", /\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi],
  ["local_path", /\b[A-Z]:\\Users\\[^\s`"'<>]+|\/(?:Users|home)\/[^\s`"'<>]+/gi],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRules(privateTerms = []) {
  const terms = privateTerms.map((term) => term.trim()).filter(Boolean);
  return terms.length
    ? [...defaultRules, ["brand_term", new RegExp(`\\b(?:${terms.map(escapeRegExp).join("|")})\\b`, "gi")]]
    : defaultRules;
}

export function inspectLine(line, privateTerms = []) {
  const ranges = new Map();
  for (const [category, pattern] of buildRules(privateTerms)) {
    pattern.lastIndex = 0;
    const matches = [...line.matchAll(pattern)];
    pattern.lastIndex = 0;
    if (!matches.length) continue;
    const categoryRanges = ranges.get(category) ?? [];
    for (const match of matches) {
      const start = match.index ?? 0;
      categoryRanges.push({ start, end: start + match[0].length });
    }
    ranges.set(category, categoryRanges);
  }
  const counts = [...ranges.entries()].map(([category, categoryRanges]) => {
    categoryRanges.sort((left, right) => left.start - right.start || left.end - right.end);
    let count = 0;
    let end = -1;
    for (const range of categoryRanges) {
      if (range.start >= end) count += 1;
      end = Math.max(end, range.end);
    }
    return [category, count];
  });
  return counts.sort(([left], [right]) => left.localeCompare(right)).map(([category, count]) => ({ category, count }));
}

export function formatFinding(filePath, lineNumber, categories) {
  return `${filePath}:${lineNumber} ${categories.map(({ category, count }) => `${category}=${count}`).join(" ")}`;
}

async function listTextFiles(targetPath) {
  const entries = await readdir(targetPath, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const entryPath = resolve(targetPath, entry.name);
    if (entry.isDirectory()) paths.push(...(await listTextFiles(entryPath)));
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) paths.push(entryPath);
  }
  return paths;
}

function displayPath(targetPath, externalIndex) {
  const relativePath = relative(repositoryRoot, targetPath);
  if (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath)) {
    return relativePath.split(sep).join("/");
  }
  return `external/file-${externalIndex}`;
}

async function run() {
  const args = process.argv.slice(2);
  const paths = [];
  let termsPath = process.env.SITEINDEX_SECURITY_TERMS_FILE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--terms-file") termsPath = args[++index];
    else paths.push(args[index]);
  }

  let privateTerms = [];
  if (termsPath) {
    try {
      privateTerms = (await readFile(resolve(termsPath), "utf8")).split(/\r?\n/);
    } catch {
      console.warn(formatFinding("external/terms-file", 0, [{ category: "scan_config_error", count: 1 }]));
    }
  }

  const targets = paths.length ? paths : ["skills", "templates"];
  let externalIndex = 0;
  for (const target of targets) {
    const resolvedTarget = resolve(repositoryRoot, target);
    const targetRelative = relative(repositoryRoot, resolvedTarget);
    const targetIsExternal =
      targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative);
    let files;
    try {
      const entry = await stat(resolvedTarget);
      files = entry.isDirectory() ? await listTextFiles(resolvedTarget) : [resolvedTarget];
    } catch {
      externalIndex += 1;
      console.warn(
        formatFinding(targetIsExternal ? `external/file-${externalIndex}` : target, 0, [
          { category: "scan_error", count: 1 },
        ]),
      );
      continue;
    }
    for (const filePath of files.sort()) {
      let content;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        if (!targetIsExternal)
          console.warn(formatFinding(displayPath(filePath, externalIndex), 0, [{ category: "scan_error", count: 1 }]));
        else {
          externalIndex += 1;
          console.warn(formatFinding(`external/file-${externalIndex}`, 0, [{ category: "scan_error", count: 1 }]));
        }
        continue;
      }
      if (targetIsExternal) externalIndex += 1;
      const shownPath = displayPath(filePath, externalIndex);
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        const categories = inspectLine(line, privateTerms);
        if (categories.length) console.warn(formatFinding(shownPath, index + 1, categories));
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run();
