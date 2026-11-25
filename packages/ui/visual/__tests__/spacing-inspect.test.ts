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

describe("shared table header and InfoTooltip control exceptions", () => {
  it("tags only the exact header sort and 20px help controls", async () => {
    const dom = new JSDOM(`<main>
      <table class="si-table"><thead><tr>
        <th><span class="si-table-heading"><button class="si-sort-button" data-size="28" style="padding:0">排序</button><button class="si-info-tooltip-trigger" data-size="20" style="padding:0">说明</button></span></th>
        <th><button class="si-sort-button" data-size="28" style="padding:0">独立排序</button></th>
      </tr></thead></table>
      <button class="si-info-tooltip-trigger" data-size="20" style="padding:0">其他页面说明</button>
      <button class="si-kpi-card is-interactive" data-size="88">待处理提醒</button>
      <button data-size="18" style="padding:0">普通按钮</button>
    </main>`, { runScripts: "outside-only" });
    for (const button of dom.window.document.querySelectorAll("button")) {
      const size = Number(button.getAttribute("data-size"));
      button.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: size, bottom: size, width: size, height: size, toJSON: () => ({}) });
    }
    const page = { evaluate: async (script: string) => dom.window.eval(script) } as unknown as Page;
    const findings = (await inspectSpacing(page, "test")).filter(({ rule }) => rule === "S1" || rule === "S2");
    expect(findings.map(({ exceptionId }) => exceptionId)).toEqual([
      "table-heading-controls-zero-padding",
      "info-tooltip-20px", "info-tooltip-zero-padding",
      "table-heading-controls-zero-padding",
      "info-tooltip-20px", "info-tooltip-zero-padding",
      undefined, undefined,
    ]);
  });
});
