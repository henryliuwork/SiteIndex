import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TodoManualHistoryEntry, TodoManualState, TodoManualStatus, TodoRuleFinding, TodoRuleScanSummary, UpdateTodoManualInput } from "@siteindex/shared";
import { atomicWrite } from "../io/atomic-write";
import { readJsonl } from "../io/jsonl";
import { pathsForProject } from "../io/project-layout";

const pending = new Map<string, Promise<unknown>>();
const statuses: readonly TodoManualStatus[] = ["open", "in_progress", "pending_review", "done", "ignored"];

/** Serialize the complete read-modify-write operation within this process. */
function serialized<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectPath);
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  pending.set(key, current);
  void current.then(() => { if (pending.get(key) === current) pending.delete(key); },
    () => { if (pending.get(key) === current) pending.delete(key); });
  return current;
}

async function files(projectPath: string): Promise<{ states: string; history: string }> {
  const paths = await pathsForProject(projectPath);
  return { states: path.join(projectPath, paths.todoStates), history: path.join(projectPath, paths.todoHistory) };
}

function jsonl(rows: readonly object[]): string {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

async function readStates(file: string): Promise<TodoManualState[]> {
  const rows = await readJsonl(file);
  const seen = new Set<string>();
  return rows.map((row) => {
    if (typeof row.dedupe_key !== "string" || !row.dedupe_key || seen.has(row.dedupe_key)
      || !statuses.includes(row.status as TodoManualStatus) || (row.note !== null && typeof row.note !== "string")
      || typeof row.updated_at !== "string" || (row.absence_confirmed_at !== undefined
        && row.absence_confirmed_at !== null && typeof row.absence_confirmed_at !== "string")) {
      throw new Error("待办人工状态文件无效，未进行修改。");
    }
    seen.add(row.dedupe_key);
    return row as unknown as TodoManualState;
  });
}

async function readHistory(file: string): Promise<TodoManualHistoryEntry[]> {
  return await readJsonl(file) as unknown as TodoManualHistoryEntry[];
}

/** Preserve the old state on write failure; roll back the history if the state replace fails. */
async function persist(target: { states: string; history: string }, states: TodoManualState[], oldHistory: TodoManualHistoryEntry[], events: TodoManualHistoryEntry[]): Promise<void> {
  if (events.length) await atomicWrite(target.history, jsonl([...oldHistory, ...events]));
  try {
    await atomicWrite(target.states, jsonl(states));
  } catch (error) {
    if (events.length) {
      try { await atomicWrite(target.history, jsonl(oldHistory)); }
      catch { throw new Error("待办状态写入失败，历史回滚失败，请检查本地待办历史文件。", { cause: error }); }
    }
    throw error;
  }
}

export async function readTodoManualStates(projectPath: string): Promise<TodoManualState[]> {
  return readStates((await files(projectPath)).states);
}

export async function readTodoManualHistory(projectPath: string, dedupeKey: string): Promise<TodoManualHistoryEntry[]> {
  return (await readHistory((await files(projectPath)).history)).filter((entry) => entry.dedupe_key === dedupeKey);
}

/** Callers validate the finding exists; omitted fields leave the user's values untouched. */
export function updateTodoManualState(projectPath: string, input: UpdateTodoManualInput, now = new Date().toISOString()): Promise<TodoManualState> {
  return serialized(projectPath, async () => {
    if (!input.dedupe_key?.trim() || (input.status !== undefined && !statuses.includes(input.status))
      || (input.note !== undefined && input.note !== null && typeof input.note !== "string")
      || (input.status === undefined && input.note === undefined)) throw new Error("待办更新内容无效。");
    const target = await files(projectPath);
    const [states, history] = await Promise.all([readStates(target.states), readHistory(target.history)]);
    const index = states.findIndex((row) => row.dedupe_key === input.dedupe_key);
    const previous = index >= 0 ? states[index]! : undefined;
    const state: TodoManualState = { dedupe_key: input.dedupe_key, status: input.status ?? previous?.status ?? "open",
      note: input.note !== undefined ? input.note : previous?.note ?? null, updated_at: now,
      ...(previous?.absence_confirmed_at ? { absence_confirmed_at: previous.absence_confirmed_at } : {}) };
    const events: TodoManualHistoryEntry[] = [];
    if (input.status !== undefined && input.status !== previous?.status) {
      events.push({ event_id: randomUUID(), dedupe_key: input.dedupe_key, action: "status_changed",
        from_status: previous?.status ?? null, to_status: input.status, changed_at: now });
      state.absence_confirmed_at = null;
    }
    if (input.note !== undefined && input.note !== (previous?.note ?? null)) {
      events.push({ event_id: randomUUID(), dedupe_key: input.dedupe_key, action: "note_changed", note: input.note, changed_at: now });
    }
    if (index >= 0) states[index] = state; else states.push(state);
    await persist(target, states, history, events);
    return state;
  });
}

/** Reconcile only trusted complete scans. Findings remain owned by the rule module. */
export function reconcileTodoManualStates(projectPath: string, findings: readonly TodoRuleFinding[], scan: TodoRuleScanSummary): Promise<TodoManualState[]> {
  return serialized(projectPath, async () => {
    const target = await files(projectPath);
    const states = await readStates(target.states);
    if (scan.status !== "complete" || !scan.evaluated_at) return states;
    const findingsByKey = new Map(findings.map((finding) => [finding.dedupe_key, finding]));
    const events: TodoManualHistoryEntry[] = [];
    let changed = false;
    const updated = states.map((state): TodoManualState => {
      const finding = findingsByKey.get(state.dedupe_key);
      if (state.status !== "done") return state;
      if (!finding && !state.absence_confirmed_at) {
        changed = true;
        return { ...state, absence_confirmed_at: scan.evaluated_at };
      }
      if (finding && state.absence_confirmed_at) {
        changed = true;
        events.push({ event_id: randomUUID(), dedupe_key: state.dedupe_key, action: "rule_reopened", from_status: "done",
          to_status: "pending_review", rule_id: finding.rule_id, absence_confirmed_at: state.absence_confirmed_at,
          changed_at: scan.evaluated_at! });
        return { ...state, status: "pending_review", absence_confirmed_at: null, updated_at: scan.evaluated_at! };
      }
      return state;
    });
    if (changed) await persist(target, updated, events.length ? await readHistory(target.history) : [], events);
    return updated;
  });
}
