import { describe, expect, it, vi } from "vitest";
import { classifyDataSurface, waitForDataSurface, type DataSurfaceState } from "./readiness";

describe("ui:check data surface readiness", () => {
  it("classifies visible table, loading, empty, and error surfaces", () => {
    expect(classifyDataSurface({ table: true, pagination: true, empty: false, error: false, loading: true })).toBe("loading");
    expect(classifyDataSurface({ table: true, pagination: false, empty: false, error: false, loading: true })).toBe("loading");
    expect(classifyDataSurface({ table: false, pagination: false, empty: true, error: true, loading: true })).toBe("loading");
    expect(classifyDataSurface({ table: true, pagination: true, empty: true, error: false, loading: false })).toBe("empty");
    expect(classifyDataSurface({ table: false, pagination: false, empty: true, error: false, loading: false })).toBe("empty");
    expect(classifyDataSurface({ table: false, pagination: false, empty: false, error: true, loading: false })).toBe("error");
    expect(classifyDataSurface({ table: false, pagination: false, empty: false, error: false, loading: false })).toBe("missing");
  });

  it("waits for a delayed table instead of accepting the initial loading state", async () => {
    let state: DataSurfaceState = "loading";
    const readState = vi.fn(async () => state);
    setTimeout(() => { state = "table"; }, 60);

    await expect(waitForDataSurface(readState, { timeoutMs: 250, pollMs: 10 })).resolves.toBe("table");
    expect(readState.mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["empty", "error"] as const)("accepts an explicit %s terminal state", async (state) => {
    await expect(waitForDataSurface(async () => state, { stabilityMs: 0 })).resolves.toBe(state);
  });

  it("does not accept a transient empty table while the mock query is pending", async () => {
    let state: DataSurfaceState = "empty";
    setTimeout(() => { state = "loading"; }, 20);
    setTimeout(() => { state = "table"; }, 60);

    await expect(waitForDataSurface(async () => state, { timeoutMs: 300, pollMs: 5, stabilityMs: 50 })).resolves.toBe("table");
  });

  it("fails when the table remains missing after the timeout", async () => {
    await expect(waitForDataSurface(async () => "missing", { timeoutMs: 25, pollMs: 5 }))
      .rejects.toThrow("最后状态：missing");
  });

  it("does not treat a continuously loading content surface as ready", async () => {
    const readState = vi.fn(async () => "loading" as const);

    await expect(waitForDataSurface(readState, { timeoutMs: 25, pollMs: 5 }))
      .rejects.toThrow("最后状态：loading");
    expect(readState.mock.calls.length).toBeGreaterThan(1);
  });
});
