// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterCheckbox, FilterField, FilterGroup, FilterPopover } from "../filter-popover";
import { Select } from "../form-controls";
import { Button } from "../primitives";

afterEach(cleanup);

describe("FilterPopover", () => {
  it("labels each select, groups options, and exposes a focusable checkbox", async () => {
    const onValueChange = vi.fn();
    const onCheckedChange = vi.fn();
    render(<FilterPopover label="产品筛选" trigger={<Button>筛选</Button>}>
      <FilterGroup>
        <FilterField label="库存状态"><Select value="all" options={[{ value: "all", label: "全部" }, { value: "in", label: "有货" }]} onValueChange={onValueChange} /></FilterField>
        <FilterField label="分类"><Select value="all" options={[{ value: "all", label: "全部" }]} onValueChange={onValueChange} /></FilterField>
      </FilterGroup>
      <FilterCheckbox label="仅关注分类" checked={false} onCheckedChange={onCheckedChange} />
    </FilterPopover>);

    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    const dialog = await screen.findByRole("dialog", { name: "产品筛选" });
    expect(within(dialog).getByRole("combobox", { name: "库存状态" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "分类" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("combobox", { name: "库存状态" }));
    fireEvent.click(await screen.findByRole("option", { name: "有货" }));
    expect(onValueChange).toHaveBeenCalledWith("in");
    const checkbox = within(dialog).getByRole("checkbox", { name: "仅关注分类" });
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    fireEvent.click(checkbox);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("returns focus to its trigger on Escape", async () => {
    render(<FilterPopover label="筛选" trigger={<Button>打开筛选</Button>}><FilterCheckbox label="仅关注分类" checked={false} onCheckedChange={() => undefined} /></FilterPopover>);
    const trigger = screen.getByRole("button", { name: "打开筛选" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "筛选" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "筛选" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
