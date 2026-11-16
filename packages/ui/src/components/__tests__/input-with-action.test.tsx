// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Input } from "../form-controls";
import { InputWithAction } from "../input-with-action";
import { Button } from "../primitives";

afterEach(cleanup);

describe("InputWithAction", () => {
  it("keeps the input before one or more accessible actions in a shared group", () => {
    const onDetect = vi.fn();
    const onBrowse = vi.fn();
    const { container } = render(<InputWithAction
      className="test-path-field"
      action={<><Button onClick={onDetect}>检测</Button><Button onClick={onBrowse}>选择</Button></>}
    >
      <Input aria-label="网站地址" value="https://example.test" readOnly />
    </InputWithAction>);

    const input = screen.getByRole("textbox", { name: "网站地址" });
    const detect = screen.getByRole("button", { name: "检测" });
    const browse = screen.getByRole("button", { name: "选择" });
    const group = container.querySelector(".si-input-with-action");
    expect(group?.classList.contains("test-path-field")).toBe(true);
    expect(group?.firstElementChild).toBe(input);
    expect(input.compareDocumentPosition(detect) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detect.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(detect);
    fireEvent.click(browse);
    expect(onDetect).toHaveBeenCalledOnce();
    expect(onBrowse).toHaveBeenCalledOnce();
  });
});
