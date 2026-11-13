import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type TodoRuleFinding } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readTodoManualHistory, readTodoManualStates, reconcileTodoManualStates, updateTodoManualState } from "../src/todos/manual-store";

const roots: string[] = [];
const first = "2026-11-13T01:00:00.000Z";
const second = "2026-11-13T02:00:00.000Z";
const third = "2026-11-13T03:00:00.000Z";
const finding: TodoRuleFinding = { dedupe_key: "seo:demo", rule_id: "seo.missing_title", title: "虚构页面缺少标题",
  subject: { kind: "page", key: "https://example.test/demo" },
  sources: [{ path: "seoPages", record_key: "https://example.test/demo", collected_at: first }], first_seen_at: first, last_seen_at: first };

async function project(layout: "legacy" | "workspace"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-todo-manual-"));
  roots.push(root);
  const site = path.join(root, pathsFor(layout).site);
  await mkdir(path.dirname(site), { recursive: true });
  await writeFile(site, "{}\n");
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("todo manual state", () => {
  it.each(["legacy", "workspace"] as const)("preserves notes and history and reopens only after confirmed absence in %s", async (layout) => {
    const root = await project(layout);
    await updateTodoManualState(root, { dedupe_key: finding.dedupe_key, status: "done", note: "人工备注" }, first);
    await updateTodoManualState(root, { dedupe_key: "ignored", status: "ignored", note: "保留" }, first);
    await reconcileTodoManualStates(root, [], { status: "partial", evaluated_at: second });
    expect((await readTodoManualStates(root))[0]).toMatchObject({ status: "done", note: "人工备注", absence_confirmed_at: null });
    await reconcileTodoManualStates(root, [], { status: "failed", evaluated_at: second });
    await reconcileTodoManualStates(root, [], { status: "complete", evaluated_at: second });
    expect((await readTodoManualStates(root))[0]).toMatchObject({ status: "done", note: "人工备注", absence_confirmed_at: second });
    await reconcileTodoManualStates(root, [finding], { status: "partial", evaluated_at: third });
    expect((await readTodoManualStates(root))[0]?.status).toBe("done");
    await reconcileTodoManualStates(root, [finding], { status: "complete", evaluated_at: third });
    const states = await readTodoManualStates(root);
    expect(states[0]).toMatchObject({ status: "pending_review", note: "人工备注", absence_confirmed_at: null });
    expect(states[1]).toMatchObject({ status: "ignored", note: "保留" });
    const history = await readTodoManualHistory(root, finding.dedupe_key);
    expect(history.map((event) => event.action)).toEqual(["status_changed", "note_changed", "rule_reopened"]);
    expect(history[2]).toMatchObject({ from_status: "done", to_status: "pending_review", absence_confirmed_at: second, rule_id: finding.rule_id });
    await reconcileTodoManualStates(root, [finding], { status: "complete", evaluated_at: third });
    expect(await readTodoManualHistory(root, finding.dedupe_key)).toHaveLength(3);
  }, 30_000);

  it("serializes concurrent manual updates without losing either field", async () => {
    const root = await project("legacy");
    await Promise.all([
      updateTodoManualState(root, { dedupe_key: "demo", status: "in_progress" }, first),
      updateTodoManualState(root, { dedupe_key: "demo", note: "synthetic note" }, second),
    ]);
    expect(await readTodoManualStates(root)).toMatchObject([{ status: "in_progress", note: "synthetic note" }]);
    expect((await readTodoManualHistory(root, "demo")).map((event) => event.action)).toEqual(["status_changed", "note_changed"]);
  }, 30_000);

  it("does not replace corrupted state or report a failed history write as success", async () => {
    const root = await project("legacy");
    await updateTodoManualState(root, { dedupe_key: "demo", note: "保留" }, first);
    const paths = pathsFor("legacy");
    const statePath = path.join(root, paths.todoStates);
    const previous = await readFile(statePath, "utf8");
    await rm(path.join(root, paths.todoHistory), { force: true });
    await mkdir(path.join(root, paths.todoHistory));
    await expect(updateTodoManualState(root, { dedupe_key: "demo", status: "done" }, second)).rejects.toThrow();
    expect(await readFile(statePath, "utf8")).toBe(previous);
    await writeFile(statePath, "{broken\n");
    await expect(updateTodoManualState(root, { dedupe_key: "demo", note: "new" }, third)).rejects.toThrow();
    expect(await readFile(statePath, "utf8")).toBe("{broken\n");
  }, 30_000);
});
