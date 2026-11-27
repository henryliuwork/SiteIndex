import { describe, expect, it } from "vitest";
import { isDataTableRoute, routeCaseUrl } from "./routes";

describe("ui:check data table routes", () => {
  it.each([
    "/",
    "/p/demo/products",
    "/p/demo/inventory",
    "/p/demo/edm",
    "/p/demo/seo",
    "/p/demo/content",
    "/p/demo/settings/categories",
  ])("waits for the table surface on %s", (route) => {
    expect(isDataTableRoute(route)).toBe(true);
  });

  it.each(["/p/demo", "/p/demo/overview", "/p/demo/readme"])("does not require a table on %s", (route) => {
    expect(isDataTableRoute(route)).toBe(false);
  });
});

describe("ui:check route isolation", () => {
  it("reloads separate cases for the same hash route without losing mock mode", () => {
    const detect = routeCaseUrl("http://127.0.0.1:1234", "/?mock=error", "/new/url", "new-project-woo-detect");
    const source = routeCaseUrl("http://127.0.0.1:1234", "/?mock=error", "/new/url", "new-project-woo-source");
    expect(detect).not.toBe(source);
    expect(new URL(source).searchParams.get("mock")).toBe("error");
    expect(new URL(source).hash).toBe("#/new/url");
  });
});
