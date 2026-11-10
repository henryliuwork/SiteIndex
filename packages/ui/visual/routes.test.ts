import { describe, expect, it } from "vitest";
import { isDataTableRoute } from "./routes";

describe("ui:check data table routes", () => {
  it.each([
    "/p/demo/products",
    "/p/demo/inventory",
    "/p/demo/edm",
    "/p/demo/seo",
    "/p/demo/settings/categories",
  ])("waits for the table surface on %s", (route) => {
    expect(isDataTableRoute(route)).toBe(true);
  });

  it.each(["/", "/p/demo", "/p/demo/overview", "/p/demo/readme"])("does not require a table on %s", (route) => {
    expect(isDataTableRoute(route)).toBe(false);
  });
});
