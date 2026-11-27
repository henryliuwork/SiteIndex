import type { Locator, Page } from "playwright-core";

export interface T7Finding { rule: "t7-sort"; message: string }

export const sortHeaderXPath = (direction: "ascending" | "descending" | "none") => `ancestor::th[@aria-sort='${direction}']`;

export function rowOrderFinding(tableName: string, columnName: string, asc: readonly string[], desc: readonly string[]): T7Finding | null {
  if (asc.length < 2 || desc.length < 2) {
    return { rule: "t7-sort", message: `${tableName}「${columnName}」缺少至少两行可排序的合成数据（升序 ${asc.length}、降序 ${desc.length}）。` };
  }
  if (new Set(asc).size !== asc.length || new Set(desc).size !== desc.length) {
    return { rule: "t7-sort", message: `${tableName}「${columnName}」存在重复行 ID，无法核对行序。` };
  }
  if (asc.join("\u0000") === desc.join("\u0000")) {
    return { rule: "t7-sort", message: `${tableName}「${columnName}」升序与降序行序相同；检查排序接线或合成数据区分度。` };
  }
  return null;
}

async function rowIds(table: Locator): Promise<string[]> {
  return table.locator("tbody tr[data-row-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id") ?? ""));
}

/** 只检查当前可见的 DataTable 和表头排序按钮；隐藏列另由页面测试覆盖。 */
export async function inspectT7Sort(page: Page): Promise<T7Finding[]> {
  const findings: T7Finding[] = [];
  const tables = page.locator(".si-data-table:visible");
  for (let tableIndex = 0; tableIndex < await tables.count(); tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const tableName = await table.getAttribute("aria-label") ?? `表格 ${tableIndex + 1}`;
    const buttons = table.locator("thead th .si-sort-button:visible");
    for (let buttonIndex = 0; buttonIndex < await buttons.count(); buttonIndex += 1) {
      const button = buttons.nth(buttonIndex);
      const columnName = (await button.innerText()).trim();
      const before = await rowIds(table);
      if (before.length < 2) {
        findings.push({ rule: "t7-sort", message: `${tableName}「${columnName}」当前只有 ${before.length} 行，不能把空表或单行表记为排序通过。` });
        continue;
      }
      try {
        await button.click();
        await button.locator(`xpath=${sortHeaderXPath("ascending")}`).waitFor({ state: "attached" });
        await table.locator("tbody tr[data-row-id]").first().waitFor({ state: "visible" });
        const asc = await rowIds(table);
        await button.click();
        await button.locator(`xpath=${sortHeaderXPath("descending")}`).waitFor({ state: "attached" });
        await table.locator("tbody tr[data-row-id]").first().waitFor({ state: "visible" });
        await page.waitForFunction(({ label, previous }) => {
          const currentTable = [...document.querySelectorAll<HTMLElement>(".si-data-table")]
            .find((element) => element.getAttribute("aria-label") === label);
          const current = [...(currentTable?.querySelectorAll("tbody tr[data-row-id]") ?? [])]
            .map((row) => row.getAttribute("data-row-id") ?? "");
          return current.length >= 2 && current.join("\u0000") !== previous.join("\u0000");
        }, { label: tableName, previous: asc }, { timeout: 3_000 }).catch(() => undefined);
        const desc = await rowIds(table);
        const finding = rowOrderFinding(tableName, columnName, asc, desc);
        if (finding) findings.push(finding);
        // 两次点击完成断言后恢复默认，避免同一 viewport 的后续路由读到上次持久排序。
        await button.click();
        await button.locator(`xpath=${sortHeaderXPath("none")}`).waitFor({ state: "attached" });
      } catch (error) {
        findings.push({ rule: "t7-sort", message: `${tableName}「${columnName}」排序检查失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  return findings;
}
