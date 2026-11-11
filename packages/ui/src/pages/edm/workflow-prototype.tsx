import { useState } from "react";
import { Button, Card, Chip, ConfirmDialog, Notice, Select, useToast } from "../../components";

type ExportScope = "project" | "selected";
type RecoveryScenario = "interrupted" | "permission-stopped";

interface PrototypeSkuResult {
  sku: string;
  label: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  detail?: string;
}

const recoveryExamples: Record<RecoveryScenario, { title: string; message: string; rows: PrototypeSkuResult[] }> = {
  interrupted: {
    title: "任务在应用关闭时中断",
    message: "恢复到 1 个已完成结果、1 个中断时状态未知、2 个尚未开始。未知状态不能当作失败或完成。",
    rows: [
      { sku: "DEMO-RESTORE-001", label: "已上传", tone: "ok" },
      { sku: "DEMO-RESTORE-002", label: "中断时状态未知", tone: "warn", detail: "需要由持久任务结果确认" },
      { sku: "DEMO-RESTORE-003", label: "尚未开始", tone: "neutral" },
      { sku: "DEMO-RESTORE-004", label: "尚未开始", tone: "neutral" },
    ],
  },
  "permission-stopped": {
    title: "任务因 WordPress 权限不足而停止",
    message: "恢复到 1 个已完成结果、1 个 403 失败和 2 个尚未开始。批次停止原因与逐 SKU 结果分开显示。",
    rows: [
      { sku: "DEMO-RESTORE-001", label: "已上传", tone: "ok" },
      { sku: "DEMO-RESTORE-002", label: "失败", tone: "danger", detail: "WordPress 权限不足（403），批次已停止" },
      { sku: "DEMO-RESTORE-003", label: "尚未开始", tone: "neutral" },
      { sku: "DEMO-RESTORE-004", label: "尚未开始", tone: "neutral" },
    ],
  },
};

export function EdmWorkflowPrototype({ projectName, projectSkuCount, selectedSkus }: {
  projectName: string;
  projectSkuCount: number;
  selectedSkus: readonly string[];
}) {
  const toast = useToast();
  const [scope, setScope] = useState<ExportScope>("project");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [hasGeneratedProjectList, setHasGeneratedProjectList] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [recoveryScenario, setRecoveryScenario] = useState<RecoveryScenario>("interrupted");
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const selectedCount = selectedSkus.length;

  const confirmDescription = scope === "project"
    ? `生成全项目清单，不受当前表格筛选或勾选影响（演示数据 ${projectSkuCount} 个 SKU）。重复生成建议只更新程序拥有的目标文件；目标路径与文件所有权仍待 Core 和契约确认。本原型不会写文件。`
    : `未来设想（尚未确认）：仅包含当前选择的 ${selectedCount} 个 SKU，输出为独立副本，不覆盖全项目标准清单。目标路径与功能范围都待协调确认。本原型不会写文件。`;

  const simulateExport = async () => {
    if (exporting || (scope === "selected" && selectedCount === 0)) return;
    setExporting(true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    if (scope === "project") {
      if (hasGeneratedProjectList) {
        setExportMessage("原型结果：重复生成且内容未变化，建议提示“清单已是最新”，避免重复写入。");
      } else {
        setHasGeneratedProjectList(true);
        setExportMessage("原型结果：全项目清单首次生成完成。演示没有写入文件。");
      }
    } else {
      setExportMessage(`原型结果：未来设想预览了 ${selectedCount} 个 SKU 的独立副本；不影响全项目清单，也没有写入文件。`);
    }
    setExporting(false);
    toast.info("EDM 清单流程仅为本地交互原型，没有创建或修改文件。");
  };

  const recovery = recoveryExamples[recoveryScenario];

  return <Card className="si-edm-workflow-prototype" label="EDM 导出与任务恢复交互原型">
    <details>
      <summary>展开 EDM 导出与重启恢复原型（仅本地 mock）</summary>
      <div className="si-edm-workflow-prototype-content">
        <Notice tone="warn" title="仅用于评审流程，不代表真实功能已接通。">
          下方使用虚构项目与 SKU；导出范围和重复处理是讨论方案。所选 SKU 独立副本是未来设想，尚未纳入本期已确认功能。不调用 IPC、不写项目文件，也不读取真实任务历史；真实导出与重启恢复继续保持能力门禁。
        </Notice>

        <section className="si-edm-workflow-prototype-section" aria-labelledby="si-edm-export-prototype-title">
          <h3 id="si-edm-export-prototype-title">SKU 清单导出范围</h3>
          <fieldset className="si-edm-export-scope">
            <legend>选择演示范围</legend>
            <label><input type="radio" name="edm-export-scope-prototype" value="project" checked={scope === "project"} onChange={() => setScope("project")} />全项目 SKU · 标准完整清单</label>
            <label><input type="radio" name="edm-export-scope-prototype" value="selected" checked={scope === "selected"} disabled={selectedCount === 0} onChange={() => setScope("selected")} />未来设想：当前选中 SKU · 独立副本（未确认，{selectedCount}）</label>
          </fieldset>
          <p>推荐：标准清单始终导出全项目数据，避免筛选或勾选造成完整清单被部分结果覆盖。所选 SKU 独立导出仅为未来备选，不是本期已确认功能。</p>
          <p>重复生成推荐显示“生成/更新”；内容未变化时反馈“清单已是最新”。只允许覆盖经确认由程序拥有的目标，不覆盖用户或 EDM 技能维护的文件。</p>
          <div className="si-edm-workflow-prototype-actions">
            <Button variant="primary" disabled={exporting || (scope === "selected" && selectedCount === 0)} onClick={() => setConfirmOpen(true)}>
              {exporting ? "模拟生成中…" : scope === "project" ? hasGeneratedProjectList ? "更新完整清单（模拟）" : "生成完整清单（模拟）" : `预览未来所选 SKU 副本（未确认，${selectedCount}）`}
            </Button>
            <span>当前演示项目：{projectName}</span>
          </div>
          {exporting && <p role="status">模拟生成中…</p>}
          {exportMessage && <Notice tone="info" title="导出流程原型结果">{exportMessage}</Notice>}
        </section>

        <section className="si-edm-workflow-prototype-section" aria-labelledby="si-edm-recovery-prototype-title">
          <h3 id="si-edm-recovery-prototype-title">应用重启后的逐 SKU 恢复</h3>
          <div className="si-edm-workflow-prototype-actions">
            <Select ariaLabel="模拟恢复场景" value={recoveryScenario} onValueChange={(value) => {
              setRecoveryScenario(value === "permission-stopped" ? "permission-stopped" : "interrupted");
              setRecoveryVisible(false);
            }} options={[
              { value: "interrupted", label: "应用关闭时中断" },
              { value: "permission-stopped", label: "403 权限错误后停止" },
            ]} />
            <Button onClick={() => setRecoveryVisible(true)}>模拟重启并恢复结果</Button>
          </div>
          {recoveryVisible && <div className="si-edm-recovery-preview" role="region" aria-label="重启恢复原型结果">
            <Notice tone={recoveryScenario === "interrupted" ? "warn" : "error"} title={recovery.title}>{recovery.message}</Notice>
            <p>恢复归属项目：{projectName}（演示）</p>
            <ul aria-label="恢复逐 SKU 结果示例">
              {recovery.rows.map((row) => <li key={row.sku}><code>{row.sku}</code><Chip tone={row.tone}>{row.label}</Chip>{row.detail && <small>{row.detail}</small>}</li>)}
            </ul>
          </div>}
        </section>
      </div>
    </details>
    <ConfirmDialog
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title="确认导出范围（仅原型）"
      description={confirmDescription}
      confirmLabel={exporting ? "模拟生成中…" : "确认模拟"}
      cancelLabel="取消"
      tone="primary"
      onConfirm={simulateExport}
    />
  </Card>;
}
