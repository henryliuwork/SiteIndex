import type { SpacingFinding } from "./spacing-inspect";

/** Keys are scoped to one route and viewport. A resolved violation must be removed in that page's migration PR. */
export interface SpacingBaseline { version: 1; checks: Record<string, string[]> }
export interface SpacingException { id: string; rule: SpacingFinding["rule"]; reason: string }
export interface SpacingExceptions { version: 1; exceptions: SpacingException[] }

export function validateSpacingExceptions(config: SpacingExceptions): void {
  if (config.version !== 1 || config.exceptions.length > 10
    || new Set(config.exceptions.map(({ id }) => id)).size !== config.exceptions.length
    || config.exceptions.some(({ id, rule, reason }) => !id.trim() || !rule.trim() || !reason.trim())) {
    throw new Error("spacing-exceptions.json 必须是版本 1、至多 10 条且每条有唯一 ID、规则和理由。");
  }
}

export function compareSpacingFindings(findings: SpacingFinding[], allowed: string[] = [], exceptions: SpacingException[] = []): {
  introduced: SpacingFinding[];
  legacyCount: number;
  resolvedKeys: string[];
} {
  const known = new Set(allowed);
  const excepted = new Set(exceptions.map(({ id, rule }) => `${rule}:${id}`));
  const actual = new Set(findings.map((finding) => finding.key));
  return {
    introduced: findings.filter((finding) => !known.has(finding.key)
      && !(finding.exceptionId && excepted.has(`${finding.rule}:${finding.exceptionId}`))),
    legacyCount: findings.filter((finding) => known.has(finding.key)).length,
    resolvedKeys: allowed.filter((key) => !actual.has(key)),
  };
}

export function hasMissingSpacingBaseline(allowed: string[] | undefined, introduced: SpacingFinding[]): boolean {
  return !allowed && introduced.length > 0;
}
