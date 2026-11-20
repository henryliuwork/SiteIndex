import type { Page } from "playwright-core";
import type { FrameFinding } from "./frame-policy";

export async function inspectTooltips(page: Page): Promise<FrameFinding[]> {
  const findings: FrameFinding[] = [];
  const triggers = page.locator(".si-info-tooltip-trigger:visible");
  const count = await triggers.count();
  for (let index = 0; index < count; index += 1) {
    const trigger = triggers.nth(index);
    if (!await trigger.count()) continue;
    const label = await trigger.getAttribute("aria-label") ?? `tooltip-${index + 1}`;
    try {
      await trigger.hover();
      await page.getByRole("tooltip").first().waitFor({ state: "visible", timeout: 2_000 });
      const result = await page.evaluate(() => {
        const bubble = document.querySelector<HTMLElement>("[role='tooltip']");
        if (!bubble) return null;
        const rect = bubble.getBoundingClientRect();
        return { width: rect.width, left: rect.left, right: rect.right,
          scrollWidth: bubble.scrollWidth, clientWidth: bubble.clientWidth, viewport: innerWidth };
      });
      if (!result || result.width > 241 || result.scrollWidth > result.clientWidth + 1
        || result.left < 7 || result.right > result.viewport - 7) {
        findings.push({ rule: "tooltip-overflow", message: `${label} 气泡溢出文字或视口（${JSON.stringify(result)}）。` });
      }
    } catch (error) {
      findings.push({ rule: "tooltip-open", message: `${label} 无法悬停打开：${error instanceof Error ? error.message : String(error)}。` });
    } finally {
      await page.keyboard.press("Escape");
      await trigger.evaluate((element) => element.blur()).catch(() => undefined);
    }
  }
  return findings;
}
