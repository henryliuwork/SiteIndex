import type { SpacingFinding } from "./spacing-inspect";

/** Keys are scoped to one route and viewport. A resolved violation must be removed in that page's migration PR. */
export interface SpacingBaseline { version: 1; checks: Record<string, string[]> }

export function compareSpacingFindings(findings: SpacingFinding[], allowed: string[] = []): {
  introduced: SpacingFinding[];
  legacyCount: number;
  resolvedKeys: string[];
} {
  const known = new Set(allowed);
  const actual = new Set(findings.map((finding) => finding.key));
  return {
    introduced: findings.filter((finding) => !known.has(finding.key)),
    legacyCount: findings.filter((finding) => known.has(finding.key)).length,
    resolvedKeys: allowed.filter((key) => !actual.has(key)),
  };
}
