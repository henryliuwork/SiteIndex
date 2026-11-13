import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import type { ProjectSummary, WorkspaceImportCheckResult } from "@siteindex/shared";
import { api, apiErrorMessage } from "../../api";
import { invalidateProjectSummary } from "../../project-queries";
import { Button, EmptyState, Notice, useToast } from "../../components";

const workspaceConfigMissingCode = "workspace_config_missing";
const workspaceMetadataMissingCode = "workspace_metadata_missing";
const workspaceMetadataInvalidCode = "workspace_metadata_invalid";
const workspaceManifestInvalidCode = "workspace_manifest_invalid";

export function WorkspaceImportCheckDialog({
  open, onOpenChange, project, available,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectSummary | null;
  available: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const projectId = project?.id;
  const importCheck = api.workspace?.importCheck;
  const [result, setResult] = useState<WorkspaceImportCheckResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const runCheck = useCallback(async (apply: boolean, notify: boolean) => {
    if (!projectId || !available || typeof importCheck !== "function") return;
    const currentRequest = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const next = await importCheck(projectId, apply ? { apply: true } : undefined);
      if (currentRequest !== requestId.current) return;
      setResult(next);
      if (apply) await invalidateProjectSummary(queryClient, projectId);
      if (notify) {
        if (apply) toast.success(`自动补齐请求完成，返回 ${next.repaired.length} 个已补齐路径。`);
        else toast.success(next.issues.length === 0 ? "工作区导入检查通过。" : `工作区导入检查完成，发现 ${next.issues.length} 项待处理。`);
      }
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      const message = apiErrorMessage(cause, "工作区导入检查失败，请重试。");
      setError(message);
      toast.error(message);
    } finally {
      if (currentRequest === requestId.current) setBusy(false);
    }
  }, [available, importCheck, projectId, queryClient, toast]);

  useEffect(() => {
    if (!open) {
      requestId.current += 1;
      setBusy(false);
      setResult(null);
      setError("");
      return;
    }
    if (!projectId) return;
    setResult(null);
    setError("");
    void runCheck(false, false);
  }, [open, projectId, runCheck]);

  const issues = result?.issues ?? [];
  const autoFixableCount = issues.filter((issue) => issue.auto_fixable).length;
  const isNotWorkspace = issues.some((issue) => issue.code === workspaceConfigMissingCode);
  const metadataMissingIssue = issues.find((issue) => issue.code === workspaceMetadataMissingCode);
  const metadataInvalidIssue = issues.find((issue) => issue.code === workspaceMetadataInvalidCode);
  const manifestInvalidIssue = issues.find((issue) => issue.code === workspaceManifestInvalidCode);

  return <Dialog.Root open={open} onOpenChange={(nextOpen) => {
    if (busy) return;
    onOpenChange(nextOpen);
  }}>
    <Dialog.Portal>
      <Dialog.Overlay className="si-dialog-overlay" />
      <Dialog.Content className="si-confirm-dialog si-workspace-import-dialog" aria-busy={busy}>
        <Dialog.Title className="si-dialog-title">识别并检查工作区 · {project?.name ?? "项目"}</Dialog.Title>
        <Dialog.Description className="si-dialog-description">检查工作区文件；自动补齐只创建缺失文件或区块，不覆盖已有内容。</Dialog.Description>

        {!available && <Notice tone="info" title="导入检查暂不可用">桌面端接口尚未通过契约启用，当前不会调用真实 handler。</Notice>}
        {busy && <p className="si-workspace-import-loading" role="status" aria-live="polite">正在检查工作区导入状态…</p>}
        {error && <Notice tone="error" title="导入检查失败">{error}</Notice>}
        {result && isNotWorkspace && <Notice tone="info" title="未识别为 Agent 工作区">此项目没有找到工作区数据目录；本次没有修改项目文件。</Notice>}
        {result && !isNotWorkspace && metadataMissingIssue && !metadataMissingIssue.auto_fixable && manifestInvalidIssue
          ? <Notice tone="warn" title="workspace.json 需要先修复">
            <p>{manifestInvalidIssue.message}</p>
            <p>该清单当前无法作为抄录来源。请先修复清单，再重新检查 site.json.workspace 元数据。</p>
          </Notice>
          : result && !isNotWorkspace && metadataMissingIssue && !metadataMissingIssue.auto_fixable && <Notice tone="warn" title="site.json.workspace 需要手动补充">
            <ol className="si-workspace-import-manual-steps">
              <li>如果 <code>_site-index/workspace.json</code> 缺失，先点击“自动补齐可修复项”创建它。</li>
              <li>从 <code>_site-index/workspace.json</code> 抄录字段：<code>version</code> → <code>workspace.version</code>；每个 <code>sections[].dir</code> → <code>workspace.sections</code>（目录名数组）；<code>esp_presets</code> → <code>workspace.esp_presets</code>。</li>
              <li>把这些值手动补入 <code>_site-index/site.json</code> 的 <code>workspace</code> 对象，保留该文件其他字段，然后点击“重新检查”。这一步不会自动完成。</li>
            </ol>
          </Notice>}
        {result && !isNotWorkspace && metadataInvalidIssue && <Notice tone="warn" title="site.json.workspace 需要手动检查">
          自动补齐已跳过，请核对下方错误说明后修改配置。
        </Notice>}

        {result && result.repaired.length > 0 && <Notice tone="info" title={`本次已补齐 ${result.repaired.length} 个路径或区块`}>
          <ul className="si-workspace-import-repaired">{result.repaired.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        </Notice>}

        {result && !isNotWorkspace && issues.length === 0 && <EmptyState title="工作区导入检查通过">未发现需要补齐或手动处理的问题。</EmptyState>}
        {result && !isNotWorkspace && issues.length > 0 && <section className="si-workspace-import-issues" aria-label="导入检查问题">
          <h3>发现 {issues.length} 项待处理</h3>
          <ul>{issues.map((issue) => <li key={issue.path + ":" + issue.code}>
            <div className="si-workspace-import-issue-heading">
              <code>{issue.path}</code>
              <span className={issue.auto_fixable ? "is-fixable" : "is-manual"}>{issue.auto_fixable ? "可自动补齐" : "需要手动处理"}</span>
            </div>
            <p>{issue.code === workspaceMetadataMissingCode && manifestInvalidIssue
              ? "workspace.json 存在问题，暂时不能从中读取元数据；请先修复清单，再重新检查。"
              : issue.code === workspaceMetadataMissingCode && issue.auto_fixable ? "缺少的 workspace 元数据可自动补齐。" : issue.message}</p>
            <small>{issue.code}</small>
          </li>)}</ul>
        </section>}

        <div className="si-dialog-actions si-workspace-import-actions">
          <Button type="button" disabled={busy} onClick={() => void runCheck(false, true)}>重新检查</Button>
          {result && !isNotWorkspace && autoFixableCount > 0 && <Button type="button" variant="primary" disabled={busy} onClick={() => void runCheck(true, true)}>
            {busy ? "处理中…" : `自动补齐可修复项（${autoFixableCount}）`}
          </Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>关闭</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
