import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type StyleRule = "bare-font-size" | "bare-color" | "bare-spacing" | "font-below-minimum";

export interface StyleFinding {
  source: string;
  line: number;
  rule: StyleRule;
  signature: string;
}

export type StyleBaseline = Record<string, number>;

const declarationPattern = /(?:^|[;{}])\s*([\w-]+)\s*:\s*([^;{}]+)/g;
const pixelPattern = /(?<![\w.-])(-?(?:\d+|\d*\.\d+))(px|rem)\b/gi;
const colorFunctions = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
const hexColor = /#[\da-f]{3,8}\b/i;
const namedColors = new Set((
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
  "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
  "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
  "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
  "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
  "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
  "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
  "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
  "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
  "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
  "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
  "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
  "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
  "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
  "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
).split(/\s+/));
const colorProperties = /^(?:color|background|background-color|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|text-decoration-color|fill|stroke|caret-color|accent-color)$/;
const spacingProperties = /^(?:(?:margin|padding)(?:-(?:block|block-start|block-end|inline|inline-start|inline-end|top|right|bottom|left))?|gap|row-gap|column-gap|grid-gap|(?:scroll-margin|scroll-padding)(?:-(?:block|block-start|block-end|inline|inline-start|inline-end|top|right|bottom|left))?)$/;
const fontSizeProperties = new Set(["font-size", "font"]);
const inheritedFontKeywords = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
export const timeDisplayPatternSource = String.raw`(?:\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2})?\b|\b\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?\b|\b\d{1,2}:\d{2}\b|\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)`;

function cleanCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function addFinding(findings: StyleFinding[], source: string, css: string, index: number, rule: StyleRule, signature: string): void {
  findings.push({ source, line: css.slice(0, index).split("\n").length, rule, signature });
}

function hasNamedColor(value: string): boolean {
  return value.toLowerCase().match(/[a-z]+/g)?.some((word) => namedColors.has(word)) ?? false;
}

function resolveFontPixels(value: string, fontTokens: Map<string, number>): number | undefined {
  const normalizedValue = value.trim().toLowerCase();
  const token = normalizedValue.match(/^var\(\s*(--fs-[\w-]+)/)?.[1];
  if (token) return fontTokens.get(token);

  const calc = normalizedValue.match(/^calc\(\s*var\(\s*(--fs-[\w-]+)\s*\)\s*([+-])\s*([\d.]+)px\s*\)$/);
  if (calc) {
    const base = fontTokens.get(calc[1]);
    if (base !== undefined) return base + (calc[2] === "+" ? 1 : -1) * Number(calc[3]);
  }

  const literal = normalizedValue.match(/^(-?(?:\d+|\d*\.\d+))(px|rem)$/);
  if (!literal) return undefined;
  const amount = Number(literal[1]);
  return literal[2] === "rem" ? amount * 16 : amount;
}

function shorthandFontSize(value: string): string | undefined {
  if (/^\s*(?:inherit|initial|unset|revert|revert-layer)\s*$/i.test(value)) return undefined;
  return value.match(/(?:^|\s)(-?(?:\d+|\d*\.\d+)(?:px|rem|em|%))(?:\s*\/|\s|$)/i)?.[1];
}

export function collectFontTokens(css: string): Map<string, number> {
  const tokens = new Map<string, number>();
  const cleaned = cleanCss(css);
  for (const match of cleaned.matchAll(declarationPattern)) {
    const property = match[1].toLowerCase();
    if (!property.startsWith("--fs-")) continue;
    const value = match[2].trim().toLowerCase().match(/^(-?(?:\d+|\d*\.\d+))(px|rem)$/);
    if (value) tokens.set(property, Number(value[1]) * (value[2] === "rem" ? 16 : 1));
  }
  return tokens;
}

export function scanCssText(source: string, rawCss: string, fontTokens: Map<string, number> = new Map()): StyleFinding[] {
  const css = cleanCss(rawCss);
  const findings: StyleFinding[] = [];
  const tokenFile = /(?:^|\/)tokens\.css$/i.test(source.replace(/\\/g, "/"));

  for (const match of css.matchAll(declarationPattern)) {
    const property = match[1].toLowerCase();
    const value = match[2].trim();
    const cleanValue = value.replace(/\s*!important\s*$/i, "").trim();
    const signature = `${property}:${normalized(value)}`;
    const start = match.index ?? 0;

    if (property.startsWith("--fs-") && tokenFile) {
      const px = resolveFontPixels(cleanValue, fontTokens);
      if (px !== undefined && px < 10) addFinding(findings, source, css, start, "font-below-minimum", signature);
      continue;
    }

    if (fontSizeProperties.has(property)) {
      const sizeValue = property === "font-size" ? cleanValue : shorthandFontSize(cleanValue);
      if (sizeValue && !/^var\(\s*--fs-[\w-]+/.test(sizeValue.trim()) && !inheritedFontKeywords.has(sizeValue.trim().toLowerCase())) {
        addFinding(findings, source, css, start, "bare-font-size", signature);
      }
      if (sizeValue) {
        const px = resolveFontPixels(sizeValue, fontTokens);
        if (px !== undefined && px < 10) addFinding(findings, source, css, start, "font-below-minimum", signature);
      }
    }

    if (!tokenFile && (colorProperties.test(property) || property.startsWith("--"))) {
      const colorPart = value.replace(/var\([^)]*\)/g, " ");
      if (hexColor.test(colorPart) || colorFunctions.test(colorPart) || hasNamedColor(colorPart)) {
        addFinding(findings, source, css, start, "bare-color", signature);
      }
    }

    const customSpacing = !tokenFile && property.startsWith("--") && /(?:space|gap|margin|padding|inset|offset)/i.test(property);
    if ((!tokenFile && spacingProperties.test(property)) || customSpacing) {
      for (const dimension of value.matchAll(pixelPattern)) {
        if (Number(dimension[1]) === 0) continue;
        addFinding(findings, source, css, start, "bare-spacing", `${signature} (${dimension[0]})`);
      }
    }
  }

  return findings;
}

export function styleBaselineKey(finding: StyleFinding): string {
  return `${finding.source}|${finding.rule}|${finding.signature}`;
}

export function compareStyleFindings(findings: StyleFinding[], baseline: StyleBaseline): { introduced: StyleFinding[]; legacyCount: number; remainingBaselineCount: number } {
  const seen = new Map<string, number>();
  const introduced: StyleFinding[] = [];
  let legacyCount = 0;

  for (const finding of findings) {
    const key = styleBaselineKey(finding);
    const used = seen.get(key) ?? 0;
    seen.set(key, used + 1);
    if (used < (baseline[key] ?? 0)) legacyCount += 1;
    else introduced.push(finding);
  }

  const remainingBaselineCount = Object.entries(baseline).reduce((total, [key, count]) => total + Math.max(0, count - (seen.get(key) ?? 0)), 0);
  return { introduced, legacyCount, remainingBaselineCount };
}

export function countTimeDisplays(text: string): number {
  return Array.from(text.matchAll(new RegExp(timeDisplayPatternSource, "g"))).length;
}

async function cssFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return cssFilesUnder(absolute);
    return entry.isFile() && entry.name.endsWith(".css") ? [absolute] : [];
  }));
  return nested.flat().sort();
}

export async function scanUiStyles(sourceRoot: string): Promise<StyleFinding[]> {
  const files = await cssFilesUnder(sourceRoot);
  const tokenPath = path.join(sourceRoot, "styles", "tokens.css");
  const tokenCss = await readFile(tokenPath, "utf8");
  const fontTokens = collectFontTokens(tokenCss);
  const findings: StyleFinding[] = [];

  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replace(/\\/g, "/");
    findings.push(...scanCssText(relative, await readFile(file, "utf8"), fontTokens));
  }
  return findings;
}
