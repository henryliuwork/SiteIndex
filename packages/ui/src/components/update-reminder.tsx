import { CheckCircle2, Download, RefreshCw } from "lucide-react";
import { api } from "../api";
import { Button } from "./primitives";
import { displayVersion, useAnyRunningJob, useUpdatesController, type UpdateAction, type UpdateStatus } from "../updates";
import "./update-reminder.css";

function actionFor(status: UpdateStatus): UpdateAction | "manual" | null {
  if (status.state === "available") return "download";
  if (status.state === "ready") return "install";
  if (status.state === "error") return "check";
  if (status.state === "unsupported" && status.manual_url) return "manual";
  return null;
}

function buttonLabel(status: UpdateStatus): string {
  if (status.state === "available") return "下载更新";
  if (status.state === "ready") return "重启并安装";
  if (status.state === "error") return "重试";
  if (status.state === "unsupported") return "前往下载";
  return "";
}

export function UpdateReminder({ collapsed }: { collapsed: boolean }) {
  const controller = useUpdatesController();
  const runningQuery = useAnyRunningJob(controller.status?.state === "ready");
  const status = controller.status;
  const updates = controller.updates;
  if (!updates || !status || status.state === "idle" || status.state === "checking") return null;

  const action = actionFor(status);
  const runAction = async () => {
    if (action === "manual" && status.state === "unsupported" && status.manual_url) {
      await api.shell.openExternal(status.manual_url);
    } else if (action && action !== "manual") await controller.run(action);
  };
  const label = status.state === "downloading"
    ? `正在下载 ${Math.max(0, Math.min(100, status.percent ?? 0))}%`
    : status.state === "ready" ? "新版本已就绪"
      : status.state === "error" ? "检查更新失败"
        : `有新版本 v${displayVersion(status.latest)}`;

  if (collapsed) {
    const disabled = !action || Boolean(controller.busy);
    return <div className="si-update-collapsed-wrap">
      <button className="si-update-collapsed" type="button" aria-label={label} title={label} disabled={disabled} onClick={() => void runAction()}>
        {status.state === "ready" ? <CheckCircle2 size={18} aria-hidden="true" /> : status.state === "error" ? <RefreshCw size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
        <span className={`si-update-dot si-update-dot-${status.state}`} aria-hidden="true" />
      </button>
    </div>;
  }

  return <section className={`si-update-reminder si-update-${status.state}`} aria-label="软件更新" aria-live="polite">
    <div className="si-update-reminder-heading">
      {status.state === "error" ? <small>{label}</small> : <strong>{label}</strong>}
      {status.state === "available" && <span>SiteIndex {displayVersion(status.current)}</span>}
    </div>
    {status.state === "downloading" && <div className="si-update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, status.percent ?? 0))}>
      <span style={{ width: `${Math.max(0, Math.min(100, status.percent ?? 0))}%` }} />
    </div>}
    {status.state === "ready" && runningQuery.data && <span className="si-update-deferred">将在当前任务完成后安装</span>}
    {action && <Button size="small" variant={status.state === "ready" ? "primary" : "default"} disabled={Boolean(controller.busy)} onClick={() => void runAction()}>
      {controller.busy === "check" ? "检查中…" : controller.busy === "download" ? "开始下载…" : controller.busy === "install" ? "正在重启…" : buttonLabel(status)}
    </Button>}
  </section>;
}
