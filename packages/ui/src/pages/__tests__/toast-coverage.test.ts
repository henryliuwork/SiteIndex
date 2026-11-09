import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const auditedPages = [
  "ProjectCenterPage.tsx",
  "NewProjectWizardPage.tsx",
  "SkillsPage.tsx",
  "AppSettingsPage.tsx",
  "ReadmePage.tsx",
  "SchedulesPage.tsx",
] as const;

function isAsync(node: ts.Node): node is ts.FunctionLikeDeclaration {
  if (!(ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) return false;
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function scanSourceForMissingToast(sourceText: string, fileName = "page.tsx"): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  const eventHandlers = new Set<string>();
  const mutations: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isAsync(node.initializer)) {
      functions.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name && isAsync(node)) functions.set(node.name.text, node);
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text.startsWith("on") && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const collect = (child: ts.Node) => {
        if (ts.isIdentifier(child)) eventHandlers.add(child.text);
        if (ts.isArrowFunction(child) && isAsync(child)) eventHandlers.add(child.getText(source));
        child.forEachChild(collect);
      };
      collect(node.initializer.expression);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useMutation" && node.arguments[0]) {
      mutations.push(node.arguments[0].getText(source));
    }
    node.forEachChild(visit);
  };
  visit(source);

  const violations: string[] = mutations
    .filter((mutation) => /api\./.test(mutation) && (!/toast\.(success|info)\s*\(/.test(mutation) || !/toast\.error\s*\(/.test(mutation)))
    .map(() => "useMutation");
  for (const handler of eventHandlers) {
    const action = functions.get(handler);
    let text = action?.getText(source) ?? handler;
    if (!action && !text.startsWith("async")) continue;
    if (!/api\.|await\s+(?:verify|removeOrphan)\s*\(|await\s+\w+Query\.refetch\s*\(/.test(text)) continue;
    const referencedHelpers = new Set<string>();
    const collectHelpers = (node: ts.Node) => {
      if (ts.isIdentifier(node) && functions.has(node.text) && node.text !== handler) referencedHelpers.add(node.text);
      node.forEachChild(collectHelpers);
    };
    action?.forEachChild(collectHelpers);
    for (const helper of referencedHelpers) text += `\n${functions.get(helper)!.getText(source)}`;
    if (!/toast\.(success|info)\s*\(/.test(text) || !/toast\.error\s*\(/.test(text)) violations.push(handler);
  }
  return violations;
}

describe("B 页面异步操作 Toast 覆盖", () => {
  it("发现 API 操作缺成功或失败 Toast 时让 CI 失败", () => {
    expect(scanSourceForMissingToast(`function Page(){ const save = async () => { await api.projects.update(); }; return <button onClick={() => void save()} />; }`)).toContain("save");
    expect(scanSourceForMissingToast(`function Page(){ const action = useMutation({ mutationFn: () => api.projects.update(), onSuccess: () => toast.success("已保存") }); return <button />; }`)).toContain("useMutation");
  });

  it("所有 B 自有页面中由界面触发的 API 操作都有成功和失败 Toast", () => {
    const pagesRoot = resolve(import.meta.dirname, "..");
    const violations = auditedPages.flatMap((fileName) => {
      const source = readFileSync(resolve(pagesRoot, fileName), "utf8");
      return scanSourceForMissingToast(source, fileName).map((handler) => `${fileName}: ${handler}`);
    });
    expect(violations).toEqual([]);
  });
});
