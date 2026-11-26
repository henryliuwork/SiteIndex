import { describe, expect, it } from "vitest";
import { isDataTableRoute } from "../routes";

describe("DataTable v2 route coverage", () => {
  it.each([
    "/",
    "/schedules",
    "/p/demo/seo",
    "/p/demo/products",
    "/p/demo/inventory",
    "/p/demo/edm",
    "/p/demo/content",
    "/p/demo/todos",
    "/p/demo/settings/config",
    "/p/demo/settings/categories",
    "/p/demo/settings/files",
  ])("marks %s as a shared DataTable route", (route) => {
    expect(isDataTableRoute(route)).toBe(true);
  });

  it.each([
    "/settings",
    "/p/demo/overview",
    "/p/demo/design",
    "/p/demo/settings/runs",
    "/new/brand",
  ])("does not mark non-DataTable route %s", (route) => {
    expect(isDataTableRoute(route)).toBe(false);
  });
});
