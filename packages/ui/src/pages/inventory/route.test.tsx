// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { route } from "./route";

function CurrentLocation() {
  const { pathname, search, hash } = useLocation();
  return <output data-testid="location">{pathname}{search}{hash}</output>;
}

describe("legacy inventory route", () => {
  it("redirects to products and preserves query parameters and hash", async () => {
    render(<MemoryRouter initialEntries={["/p/demo-store/inventory?stock=out_of_stock&page=3#sku-42"]}>
      <Routes>
        <Route path={route.path} element={route.element} />
        <Route path="/p/:id/products" element={<CurrentLocation />} />
      </Routes>
    </MemoryRouter>);

    expect((await screen.findByTestId("location")).textContent).toBe("/p/demo-store/products?stock=out_of_stock&page=3#sku-42");
  });
});
