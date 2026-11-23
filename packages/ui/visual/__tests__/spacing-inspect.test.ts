import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page } from "playwright-core";
import { inspectSpacing } from "../spacing-inspect";

describe("S3 table header help exception", () => {
  it("tags only the specified 4px sort/help pair", async () => {
    const dom = new JSDOM(`<main>
      <span class="si-table-heading"><button class="si-sort-button" data-left="0">排序</button><button class="si-info-tooltip-trigger" data-left="32">说明</button></span>
      <div><button data-left="0">操作一</button><button data-left="32">操作二</button></div>
      <span class="si-table-heading"><button class="si-sort-button" data-left="0">排序</button><button class="si-info-tooltip-trigger" data-left="30">说明</button></span>
    </main>`, { runScripts: "outside-only" });
    for (const button of dom.window.document.querySelectorAll("button")) {
      const left = Number(button.getAttribute("data-left"));
      button.getBoundingClientRect = () => ({ x: left, y: 0, left, top: 0, right: left + 28, bottom: 28, width: 28, height: 28, toJSON: () => ({}) });
    }
    const page = { evaluate: async (script: string) => dom.window.eval(script) } as unknown as Page;
    const findings = (await inspectSpacing(page, "test")).filter(({ rule }) => rule === "S3");
    expect(findings).toHaveLength(3);
    expect(findings.map(({ exceptionId }) => exceptionId)).toEqual(["table-header-help-4px", undefined, undefined]);
  });
});
