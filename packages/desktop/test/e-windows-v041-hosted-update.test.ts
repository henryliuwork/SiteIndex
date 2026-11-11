import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeW2SyntheticFixture } from "../scripts/e-windows-v040-synthetic-fixture.mjs";

const workflow = readFileSync(
  new URL("../../../.github/workflows/e-windows-v040-acceptance.yml", import.meta.url),
  "utf8",
);
const acceptanceScript = readFileSync(new URL("../scripts/e-windows-v040-acceptance.mjs", import.meta.url), "utf8");

describe("Windows v0.4.0 to v0.4.1 hosted upgrade acceptance", () => {
  it("pins the verified v0.4.0 tag, asset, and installer digest as the baseline", () => {
    expect(workflow).toContain('default: "0.4.0"');
    expect(workflow).toContain('default: "334d5bee76156ad856986031020f51b2bcb7319d"');
    expect(workflow).toContain('default: "734250277"');
    expect(workflow).toContain('default: "a7414e062a18170ef00f3bb7e09d11cb2b81d2197baff8717b7ee4a9ddda2b90"');
    expect(workflow).toContain("$tagObject.sha -cne $expectedCommit");
    expect(workflow).toContain("$asset.id -ne $expectedAssetId");
    expect(workflow).toContain("$actual -cne $expectedDigest");
  });

  it("requires a newer published candidate pinned to its tag commit, Release asset, and digest", () => {
    expect(workflow).toContain('default: "0.4.1"');
    expect(workflow).toContain("hosted_update:");
    expect(workflow).toContain("candidate_release_commit:");
    expect(workflow).toContain("candidate_release_asset_id:");
    expect(workflow).toContain("candidate_release_asset_sha256:");
    expect(workflow).toContain("$latest.tag_name -cne $tag");
    expect(workflow).toContain("Candidate version tag does not resolve to the supplied source commit.");
    expect(workflow).toContain('Where-Object { $_.name -ceq "latest.yml" }');
    expect(workflow).toContain('$feedText -notmatch "(?m)^version:');
    expect(workflow).toContain('$feedText -notmatch "(?m)^\\s*url:');
    expect(workflow).toContain("$actualSha512 -cne $feedSha512Match.Groups[1].Value");
    expect(acceptanceScript).toContain("candidateReleaseCommit === report.candidateSourceCommit");
    expect(acceptanceScript).toContain("report.candidateReleaseAssetSha256 === report.candidateInstallerSha256");
    expect(acceptanceScript).toContain("OLD_RELEASE.version");
  });

  it("drives the packaged update API and checks the re-launched app version", () => {
    expect(acceptanceScript).toContain("updates.check()");
    expect(acceptanceScript).toContain("await updates.download()");
    expect(acceptanceScript).toContain("updates.install().catch");
    expect(acceptanceScript).toContain("state.version === CANDIDATE_VERSION");
    expect(acceptanceScript).toContain("oldState.version === OLD_RELEASE.version");
  });

  it("uses only reserved synthetic fixture domains", () => {
    const serialized = JSON.stringify(makeW2SyntheticFixture("https://synthetic.example.invalid"));
    const urls = serialized.match(/https?:\/\/[^\\"\s]+/gu) ?? [];

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((value) => new URL(value).hostname.endsWith(".invalid"))).toBe(true);
  });

  it("isolates roaming and machine-local data for the installed application", () => {
    expect(acceptanceScript).toContain("APPDATA: APP_DATA_ROOT");
    expect(acceptanceScript).toContain("LOCALAPPDATA: LOCAL_APP_DATA_ROOT");
    expect(acceptanceScript).toContain("no real credential vault read or written");
    expect(acceptanceScript).not.toContain("process.env.LOCALAPPDATA");
  });
});
