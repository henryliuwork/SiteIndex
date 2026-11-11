import { describe, expect, it, vi } from "vitest";
import { classifyDataSurface, classifyPageSurface, waitForDataSurface, waitForPageSurface, type DataSurfaceState } from "./readiness";

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
    vi.useFakeTimers();
    try {
      const pending = waitForDataSurface(async () => "missing", { timeoutMs: 25, pollMs: 5 });
      const timedOut = expect(pending).rejects.toThrow("最后状态：missing");
      await vi.advanceTimersByTimeAsync(30);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a continuously loading content surface as ready", async () => {
    const readState = vi.fn(async () => "loading" as const);

    vi.useFakeTimers();
    try {
      const pending = waitForDataSurface(readState, { timeoutMs: 25, pollMs: 5 });
      const timedOut = expect(pending).rejects.toThrow("最后状态：loading");
      await vi.advanceTimersByTimeAsync(30);
      await timedOut;
      expect(readState.mock.calls.length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ui:check non-table page readiness", () => {
  it("distinguishes loading, completed content, legal empty, error, and missing surfaces", () => {
    const base = { table: false, pagination: false, empty: false, error: false, loading: false, content: false, pageEmpty: false };
    expect(classifyPageSurface({ ...base, loading: true, content: true })).toBe("loading");
    expect(classifyPageSurface({ ...base, content: true })).toBe("content");
    expect(classifyPageSurface({ ...base, pageEmpty: true })).toBe("empty");
    expect(classifyPageSurface({ ...base, content: true, pageEmpty: true })).toBe("content");
    expect(classifyPageSurface({ ...base, error: true })).toBe("error");
    expect(classifyPageSurface(base)).toBe("missing");
  });

  it("waits for a mocked design page query to settle before accepting its content", async () => {
    const loadingState = classifyPageSurface({
      table: false,
      pagination: false,
      empty: false,
      error: false,
      loading: true,
      content: true,
      pageEmpty: false,
    });
    const contentState = classifyPageSurface({
      table: false,
      pagination: false,
      empty: false,
      error: false,
      loading: false,
      content: true,
      pageEmpty: false,
    });
    const states = [loadingState, loadingState, contentState, contentState];
    const readState = vi.fn(async () => states.shift() ?? contentState);

    vi.useFakeTimers();
    try {
      const pending = waitForPageSurface(readState, { timeoutMs: 250, pollMs: 5, stabilityMs: 10 });
      const completed = expect(pending).resolves.toBe("content");
      await vi.advanceTimersByTimeAsync(25);
      await completed;
      expect(readState.mock.calls.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only explicit empty and error states when a page has no content body", async () => {
    for (const terminal of ["empty", "error"] as const) {
      const readState = async () => classifyPageSurface({
        table: false,
        pagination: false,
        empty: terminal === "empty",
        error: terminal === "error",
        loading: false,
        content: false,
        pageEmpty: terminal === "empty",
      });
      await expect(waitForPageSurface(readState, { stabilityMs: 0 })).resolves.toBe(terminal);
    }
  });

  it("fails if the page remains loading instead of screenshotting it as complete", async () => {
    const readState = vi.fn(async () => classifyPageSurface({
      table: false,
      pagination: false,
      empty: false,
      error: false,
      loading: true,
      content: false,
      pageEmpty: false,
    }));

    vi.useFakeTimers();
    try {
      const pending = waitForPageSurface(readState, { timeoutMs: 25, pollMs: 5 });
      const timedOut = expect(pending).rejects.toThrow("最后状态：loading");
      await vi.advanceTimersByTimeAsync(30);
      await timedOut;
      expect(readState.mock.calls.length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when a route has neither content nor an explicit terminal state", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForPageSurface(async () => "missing", { timeoutMs: 25, pollMs: 5 });
      const timedOut = expect(pending).rejects.toThrow("最后状态：missing");
      await vi.advanceTimersByTimeAsync(30);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
