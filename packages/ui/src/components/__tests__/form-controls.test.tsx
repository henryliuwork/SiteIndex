// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Input, Select } from "../form-controls";

afterEach(cleanup);

function SelectHarness({ onValueChange }: { onValueChange: (value: string) => void }) {
  const [value, setValue] = useState("all");
  return <Select
    ariaLabel="项目筛选"
    value={value}
    options={[{ value: "all", label: "全部项目" }, { value: "active", label: "运行中" }]}
    onValueChange={(nextValue) => {
      setValue(nextValue);
      onValueChange(nextValue);
    }}
  />;
}

describe("shared form controls", () => {
  it("renders an accessible text field with its controlled value", () => {
    render(<Input aria-label="项目名称" value="Demo Store" readOnly />);
    expect((screen.getByRole("textbox", { name: "项目名称" }) as HTMLInputElement).value).toBe("Demo Store");
  });

  it("opens a keyboard-operable listbox and reports the selected option", async () => {
    const onValueChange = vi.fn();
    render(<SelectHarness onValueChange={onValueChange} />);
    const trigger = screen.getByRole("combobox", { name: "项目筛选" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("option", { name: "全部项目" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "运行中" }));
    fireEvent.click(screen.getByRole("option", { name: "运行中" }));
    expect(onValueChange).toHaveBeenCalledWith("active");
    expect(trigger.textContent).toContain("运行中");
  });
});
