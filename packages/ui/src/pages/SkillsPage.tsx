import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Copy, RefreshCw } from "lucide-react";
import type { SkillInfo, SkillTargetStatus } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { ApiErrorNotice, Button, Chip } from "../components";
import "./skills/page.css";

function statusLabel(status: SkillTargetStatus["status"]): string {
  switch (status) {
    case "latest": return "最新";
    case "outdated": return "旧版";
    case "not_installed": return "未安装";
    case "unknown_path": return "路径未知";
  }
}

function statusTone(status: SkillTargetStatus["status"]): "ok" | "warn" | "neutral" {
  if (status === "latest") return "ok";
  if (status === "outdated") return "warn";
  return "neutral";
}

function versionTone(skill: SkillInfo): "warn" | "neutral" {
  return skill.has_update ? "warn" : "neutral";
}

export function SkillsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState("");

  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills.list() });
  const activeName = selectedName ?? skillsQuery.data?.[0]?.name ?? "";
  const activeSkill = useMemo(() => skillsQuery.data?.find((skill) => skill.name === activeName), [activeName, skillsQuery.data]);
  const detailQuery = useQuery({
    queryKey: ["skills", "detail", activeName],
    queryFn: () => api.skills.get(activeName),
    enabled: Boolean(activeName),
  });
  const targetsQuery = useQuery({
    queryKey: ["skills", "targets", activeName],
    queryFn: () => api.skills.targets(activeName),
    enabled: Boolean(activeName),
  });

  const handleSyncAll = async () => {
    if (syncing) return;
    setSyncing(true);
    setFeedback("");
    try {
      await api.skills.syncAllProjects();
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      setFeedback("已同步到所有项目");
    } catch (error) {
      setFeedback("同步失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setSyncing(false);
      window.setTimeout(() => setFeedback(""), 2600);
    }
  };

  const handleCopy = async (text: string, success: string) => {
    try {
      await api.shell.copyText(text);
      setFeedback(success);
    } catch (error) {
      setFeedback("复制失败：" + (apiErrorMessage(error, "请检查剪贴板权限")));
    }
    window.setTimeout(() => setFeedback(""), 2600);
  };

  const handleInstall = async (target: SkillTargetStatus) => {
    if (!activeName || busyTarget) return;
    if (target.status === "unknown_path") {
      navigate("/settings");
      return;
    }
    setBusyTarget(target.target_id);
    setFeedback("");
    try {
      await api.skills.install(activeName, target.target_id);
      await queryClient.invalidateQueries({ queryKey: ["skills", "targets", activeName] });
      setFeedback(`${target.name} 已更新`);
    } catch (error) {
      setFeedback("安装失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setBusyTarget(null);
      window.setTimeout(() => setFeedback(""), 2600);
    }
  };

  if (skillsQuery.isLoading) return <div className="si-page-loading" role="status">正在加载 Skill…</div>;
  if (skillsQuery.isError) return <ApiErrorNotice page label="Skill 列表加载失败。" error={skillsQuery.error} onRetry={() => void skillsQuery.refetch()} />;
  if (!skillsQuery.data?.length) return <div className="si-page-loading"><strong>当前没有可用的 Skill</strong><span>检查软件 Skill 清单或安装目录后重试。</span><button type="button" onClick={() => void skillsQuery.refetch()}>重新检查</button></div>;

  const detail = detailQuery.data;
  const installText = detail
    ? `# ${detail.info.name} 安装说明\n\n在 SiteIndex 的 Skill 中心选择此 Skill，然后选择要安装的平台或项目。\n\n${(targetsQuery.data ?? []).map((target) => `- ${target.name}：${target.dir ?? "尚未配置目录"}（${statusLabel(target.status)}）`).join("\n")}`
    : "";

  return (
    <div className="si-page si-skills-page">
      <header className="si-skills-heading">
        <div>
          <h1>Skill 中心</h1>
          <p>内置 {skillsQuery.data.length} 个 Skill · 版本随 SiteIndex 更新 · {skillsQuery.data.filter((skill) => skill.has_update).length} 个有更新未同步到项目</p>
        </div>
        <Button variant="primary" disabled={syncing} icon={syncing ? <RefreshCw size={15} className="si-skills-spin" /> : undefined} onClick={() => void handleSyncAll()}>
          {syncing ? "同步中…" : "同步到所有项目"}
        </Button>
      </header>
      {feedback && <p className="si-feedback" role="status">{feedback}</p>}

      <div className="si-skills-layout">
        <section className="si-skills-list si-skills-card" aria-label="Skill 列表">
          {skillsQuery.data.map((skill) => (
            <button key={skill.name} type="button" className={`si-skill-choice${skill.name === activeName ? " active" : ""}`} aria-pressed={skill.name === activeName} onClick={() => setSelectedName(skill.name)}>
              <span className="si-skill-choice-top"><code>{skill.name}</code><Chip tone={versionTone(skill)}>{skill.version}{skill.has_update ? " 有更新" : ""}</Chip></span>
              <span className="si-skill-choice-description">{skill.description}</span>
            </button>
          ))}
        </section>

        <div className="si-skills-detail-column">
          {detailQuery.isLoading && <div className="si-page-loading" role="status">正在加载 Skill 详情…</div>}
          {detailQuery.isError && <ApiErrorNotice label="Skill 详情加载失败。" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />}
          {detail && activeSkill && <section className="si-skill-detail si-skills-card" aria-label={`${detail.info.name} 详情`}>
            <header className="si-skill-detail-heading">
              <div>
                <div className="si-skill-title"><code>{detail.info.name}</code><Chip tone={versionTone(activeSkill)}>{detail.info.version}</Chip></div>
                <p>{detail.info.description}</p>
              </div>
              <div className="si-skill-copy-actions">
                <Button icon={<Copy size={14} />} onClick={() => void handleCopy(detail.body, "已复制全文")}>复制全文</Button>
                <Button onClick={() => void handleCopy(installText, "已复制安装说明")}>复制安装说明</Button>
              </div>
            </header>
            <div className="si-skill-io-grid">
              <div><span>读取</span><code>{detail.info.reads.length ? detail.info.reads.join("\n") : "（无）"}</code></div>
              <div><span>写入</span><code>{detail.info.writes.length ? detail.info.writes.join("\n") : "（无）"}</code></div>
            </div>
            <pre className="si-skill-body"><code>{detail.body}</code></pre>
          </section>}

          <section className="si-skills-targets si-skills-card" aria-label="Skill 安装位置">
            <header><strong>安装位置 · {detail?.info.name ?? activeName}</strong></header>
            {targetsQuery.isLoading && <p className="si-skills-inline-state" role="status">正在检查安装位置…</p>}
            {targetsQuery.isError && <ApiErrorNotice className="si-skills-inline-error" label="安装位置加载失败。" error={targetsQuery.error} onRetry={() => void targetsQuery.refetch()} />}
            {targetsQuery.data?.length ? <div className="si-skill-target-list">
              {targetsQuery.data.map((target) => {
                const isProject = target.target_id.startsWith("project:");
                const action = target.status === "latest" ? (isProject ? "重新同步" : "重新安装") : target.status === "outdated" ? "更新" : target.status === "unknown_path" ? "管理目录" : "安装";
                return <div className="si-skill-target" key={target.target_id}>
                  <strong>{target.name}</strong>
                  <code>{target.dir ?? "[首次使用时确认路径]"}</code>
                  <Chip tone={statusTone(target.status)}>{statusLabel(target.status)}</Chip>
                  <Button disabled={busyTarget !== null} onClick={() => void handleInstall(target)}>{busyTarget === target.target_id ? "处理中…" : action}</Button>
                </div>;
              })}
            </div> : !targetsQuery.isLoading && !targetsQuery.isError && <p className="si-skills-inline-state">尚未检测到安装位置，可在软件设置中添加平台目录。</p>}
            <footer><span>项目内的 Skill 写在 <code>_agent/skills/</code>，README 的任务路由指向它们，任何 agent 读 README 即可找到。</span><Button onClick={() => navigate("/settings")}>管理平台目录</Button></footer>
          </section>
        </div>
      </div>
    </div>
  );
}
