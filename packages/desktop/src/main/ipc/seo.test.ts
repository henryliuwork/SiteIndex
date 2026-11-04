import { describe, expect, it, vi } from "vitest";
import type { ProjectId, SeoIssue } from "@siteindex/shared";
import type { IpcContext } from "./context.js";
import { createSeoHandlers } from "./seo.js";

const singleTarget = { url: "https://shop.example.test/page-a", rule: "desc_missing" as SeoIssue["rule"] };
const batchTargets = [
  { url: "https://shop.example.test/page-a", rule: "desc_missing" as SeoIssue["rule"] },
  { url: "https://shop.example.test/page-b", rule: "title_missing" as SeoIssue["rule"] },
];

function createContext(
  setIssueStatus = vi.fn(async () => ({ updated: 1 })),
  setRuleIgnored = vi.fn(async () => ({ updated: 1 })),
): IpcContext {
  return {
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== "demo") {
        throw { code: "PROJECT_NOT_FOUND", message: "找不到指定项目。", detail: String(value) };
      }
      return callback("demo" as ProjectId);
    },
    core: { seo: { setIssueStatus, setRuleIgnored } },
  } as unknown as IpcContext;
}

function handler(context: IpcContext, method: "seo.setIssueStatus" | "seo.setRuleIgnored") {
  const implementation = createSeoHandlers(context)[method];
  if (!implementation) throw new Error(`${method} handler is missing`);
  return implementation;
}

describe("SEO issue status IPC handlers", () => {
  it("forwards a single issue status update to Core", async () => {
    const setIssueStatus = vi.fn(async () => ({ updated: 1 }));
    const context = createContext(setIssueStatus);
    const input = { targets: [singleTarget], status: "ignored" as const };

    await expect(handler(context, "seo.setIssueStatus")("demo", input)).resolves.toEqual({ updated: 1 });
    expect(setIssueStatus).toHaveBeenCalledWith("demo", input);
  });

  it("forwards a batch issue status update to Core", async () => {
    const setIssueStatus = vi.fn(async () => ({ updated: 2 }));
    const context = createContext(setIssueStatus);
    const input = { targets: batchTargets, status: "fixed" as const };

    await expect(handler(context, "seo.setIssueStatus")("demo", input)).resolves.toEqual({ updated: 2 });
    expect(setIssueStatus).toHaveBeenCalledWith("demo", input);
  });

  it.each([true, false])("forwards whole-rule ignored=%s updates to Core", async (ignored) => {
    const setRuleIgnored = vi.fn(async () => ({ updated: 2 }));
    const context = createContext(vi.fn(async () => ({ updated: 2 })), setRuleIgnored);

    await expect(handler(context, "seo.setRuleIgnored")("demo", "desc_missing", ignored)).resolves.toEqual({
      updated: 2,
    });
    expect(setRuleIgnored).toHaveBeenCalledWith("demo", "desc_missing", ignored);
  });
});
