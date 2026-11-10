export type DataSurfaceState = "table" | "empty" | "error" | "loading" | "missing";

export interface DataSurfaceSnapshot {
  table: boolean;
  pagination: boolean;
  empty: boolean;
  error: boolean;
  loading: boolean;
}

export function classifyDataSurface(snapshot: DataSurfaceSnapshot): DataSurfaceState {
  if (snapshot.loading) return "loading";
  if (snapshot.empty) return "empty";
  if (snapshot.table && snapshot.pagination) return "table";
  if (snapshot.error) return "error";
  return "missing";
}

export function isTerminalDataSurface(state: DataSurfaceState): state is "table" | "empty" | "error" {
  return state === "table" || state === "empty" || state === "error";
}

export async function waitForDataSurface(
  readState: () => Promise<DataSurfaceState>,
  options: { timeoutMs?: number; pollMs?: number; stabilityMs?: number } = {},
): Promise<"table" | "empty" | "error"> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 50;
  const stabilityMs = options.stabilityMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastState: DataSurfaceState = "missing";

  do {
    lastState = await readState();
    if (isTerminalDataSurface(lastState)) {
      const remainingForConfirmation = Math.max(0, deadline - Date.now());
      if (remainingForConfirmation === 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(stabilityMs, remainingForConfirmation)));
      const confirmedState = await readState();
      if (confirmedState === lastState && isTerminalDataSurface(confirmedState)) return confirmedState;
      lastState = confirmedState;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  } while (Date.now() < deadline);

  throw new Error(`等待表格进入已加载、空状态或错误状态超时（${timeoutMs}ms）；最后状态：${lastState}。`);
}
