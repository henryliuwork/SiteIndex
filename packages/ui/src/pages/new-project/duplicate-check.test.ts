import { describe, expect, it } from "vitest";
import { findExistingProject, normalizeProjectDomain } from "./duplicate-check";

const projects = [
  { id: "existing", name: "Existing project", domain: "example.com" },
  { id: "store", name: "Store project", domain: "store.example.com" },
];

describe("new-project duplicate domain check", () => {
  it("normalizes scheme, www, host casing, port and trailing slash", () => {
    expect(normalizeProjectDomain(" HTTP://WWW.Example.COM:8080/catalog/ ")).toBe("example.com");
    expect(normalizeProjectDomain("https://example.com./path///")).toBe("example.com");
    expect(normalizeProjectDomain("example.com")).toBe("example.com");
    expect(normalizeProjectDomain("ftp://example.com")).toBeNull();
  });

  it("matches either the typed address or a redirect destination", () => {
    expect(findExistingProject(projects, "http://WWW.Example.com/")?.id).toBe("existing");
    expect(findExistingProject(projects, "new-host.invalid", "https://WWW.Example.com/final/")?.id).toBe("existing");
  });

  it("keeps distinct subdomains separate and ignores invalid candidates", () => {
    expect(findExistingProject(projects, "https://blog.example.com/")).toBeNull();
    expect(findExistingProject(projects, "https://store.example.com/")?.id).toBe("store");
    expect(findExistingProject(projects, "not a url")).toBeNull();
  });
});
