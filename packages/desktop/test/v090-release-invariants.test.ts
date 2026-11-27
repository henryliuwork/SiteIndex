import { describe, expect, it } from "vitest";
import { assertFontEvidence, assertRunJobEvidence } from "../scripts/acceptance/release-invariants.mjs";

const font = { localSource: true, loaded: true, check: true };
const fonts = { offline: true, fontFiles: 2, externalRequests: 0,
  families: { "Geist Variable": font, "Source Han Sans SC": font } };
const job = { exitCode: 0, spawnError: false, successfulViewsRun: true, lockAbsent: true };

describe("v0.9.0 packaged release invariants", () => {
  it("requires both bundled fonts to render while offline", () => {
    expect(() => assertFontEvidence(fonts)).not.toThrow();
    expect(() => assertFontEvidence({ ...fonts, families: { "Geist Variable": font } })).toThrow();
    expect(() => assertFontEvidence({ ...fonts, externalRequests: 1 })).toThrow();
    expect(() => assertFontEvidence({ ...fonts, families: { ...fonts.families,
      "Source Han Sans SC": { ...font, loaded: false } } })).toThrow();
  });

  it("requires a real successful packaged views run and no remaining lock", () => {
    expect(() => assertRunJobEvidence(job)).not.toThrow();
    expect(() => assertRunJobEvidence({ ...job, exitCode: 1 })).toThrow();
    expect(() => assertRunJobEvidence({ ...job, successfulViewsRun: false })).toThrow();
    expect(() => assertRunJobEvidence({ ...job, lockAbsent: false })).toThrow();
  });
});
