import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Copy, RefreshCw, Settings2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { SkillInfo, SkillTargetStatus } from "@siteindex/shared";
import { api } from "../api";
import { Button, Chip } from "../components";
import "./skills/page.css";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请稍后重试。";
}

function targetStatusLabel(status: SkillTargetStatus["status"]): string {
  return status === "latest" ? "已安装" : status === "outdated" ? "旧版" : status === "unknown_path" ? "路径待确认" : "未安装";
}

function targetStatusTone(status: SkillTargetStatus["status"]): "ok" | "warn" | "danger" | "neutral" {
  return status === "latest" ? "ok" : status === "outdated" ? "warn" : status === "unknown_path" ? "danger" : "neutral";
}

function installActionLabel(status: SkillTargetStatus["status"]): string {
  return status === "latest" ? "重新安装" : status === "outdated" ? "更新" : status === "unknown_path" ? "设置目录" : "安装";
}

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState("");
  const [workingTarget, setWorkingTarget] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills.list() });
  const skills = skillsQuery.data ?? [];
  const selectedSkillName = selectedName || skills[0]?.name || "";
  const detailQuery = useQuery({
    queryKey: ["skills", "detail", selectedSkillName],
    queryFn: () => api.skills.get(selectedSkillName),
    enabled: Boolean(selectedSkillName),
  });
  const targetsQuery = useQuery({
    queryKey: ["skills", "targets", selectedSkillName],
    queryFn: () => api.skills.targets(selectedSkillName),
    enabled: Boolean(selectedSkillName),
  });

  const retryAll = () => {
    void skillsQuery.refetch();
    if (selectedSkillName) {
      void detailQuery.refetch();
      void targetsQuery.refetch();
    }
  };

  const copyText = async (text: string, message: string) => {
    setError("");
    try {
      await api.shell.copyText(text);
      setFeedback(message);
    } catch (copyError) {
      setFeedback("");
      setError("复制失败：" + errorText(copyError));
    }
  };

  const installSkill = async (target: SkillTargetStatus) => {
    if (target.status === "unknown_path") return;
    setWorkingTarget(target.target_id);
    setFeedback("");
    setError("");
    try {
      await api.skills.install(selectedSkillName, target.target_id);
      await targetsQuery.refetch();
      setFeedback(`${target.name}：${targetStatusLabel(target.status) === "旧版" ? "Skill 已更新" : "Skill 已安装"}`);
    } catch (installError) {
      setError(`${target.name} 安装失败：${errorText(installError)}`);
    } finally {
      setWorkingTarget("");
    }
  };

  const syncProjects = async () => {
    setSyncing(true);
    setFeedback("");
    setError("");
    try {
      await api.skills.syncAllProjects();
      await queryClient.invalidateQueries({ queryKey: ["skills", "targets"] });
      setFeedback("所有项目的 Skill 已同步。");
    } catch (syncError) {
      setError("同步失败：" + errorText(syncError));
    } finally {
      setSyncing(false);
    }
  };

  if (skillsQuery.isLoading) return <div className="si-page-loading" role="status">正在读取 Skill 列表…</div>;
  if (skillsQuery.isError) return <div className="si-page-error" role="alert">Skill 列表加载失败：{errorText(skillsQuery.error)}<button type="button" onClick={retryAll}>重试</button></div>;

  const updateCount = skills.filter((skill: SkillInfo) => skill.has_update).length;
  const selectedDetail = detailQuery.data;
  const selectedSkill = selectedDetail?.info;
  const targets = targetsQuery.data ?? [];
  const installationInstructions = selectedSkill
    ? `${selectedSkill.name} ${selectedSkill.version}\n\n安装位置：\n${targets.map((target) => `${target.name}：${target.dir ?? "首次使用时确认路径"}`).join("\n")}`
    : "";

  return <div className="si-page si-skills-page">
    <header className="si-page-heading">
      <div><h1>Skill 中心</h1><p>内置 {skills.length} 个 Skill · 版本随 SiteIndex 更新 · {updateCount} 个有更新未同步到项目</p></div>
      <Button variant="primary" onClick={() => void syncProjects()} disabled={syncing} icon={<RefreshCw size={15} />}>{syncing ? "同步中…" : "同步到所有项目"}</Button>
    </header>
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    {error && <p className="si-skills-action-error" role="alert">{error}</p>}
    {skills.length === 0 ? <section className="si-skills-empty" role="status"><strong>还没有可用的 Skill</strong><span>检查软件内置文件后，可以在这里查看并安装到各个平台。</span><Button onClick={() => void skillsQuery.refetch()}>重新读取</Button></section> : <div className="si-skills-layout">
      <nav className="si-skills-list" aria-label="Skill 列表">
        {skills.map((skill) => <button key={skill.name} type="button" className={`si-skill-option${skill.name === selectedSkillName ? " active" : ""}`} aria-pressed={skill.name === selectedSkillName} onClick={() => { setSelectedName(skill.name); setFeedback(""); setError(""); }}>
          <span className="si-skill-option-heading"><code>{skill.name}</code><span className="si-skill-option-version"><Chip tone={skill.has_update ? "warn" : "neutral"}>{skill.version}{skill.has_update ? " 有更新" : ""}</Chip></span></span>
          <span className="si-skill-option-description">{skill.description}</span>
        </button>)}
      </nav>

      <main className="si-skills-detail">
        {detailQuery.isLoading || targetsQuery.isLoading ? <section className="si-skills-detail-loading" role="status">正在读取 Skill 详情与安装位置…</section>
          : detailQuery.isError || targetsQuery.isError || !selectedDetail || !selectedSkill ? <section className="si-page-error si-skills-detail-error" role="alert">Skill 详情加载失败：{errorText(detailQuery.error ?? targetsQuery.error)}<button type="button" onClick={retryAll}>重试</button></section>
            : <>
              <section className="si-skill-info-card">
                <div className="si-skill-info-heading">
                  <div><h2><code>{selectedSkill.name}</code><Chip tone={selectedSkill.has_update ? "warn" : "neutral"}>{selectedSkill.version}{selectedSkill.has_update ? " 有更新" : ""}</Chip></h2><p>{selectedSkill.description}</p></div>
                  <div className="si-skill-copy-actions">
                    <Button onClick={() => void copyText(selectedDetail.body, "已复制 Skill 全文。")} icon={<Copy size={14} />}>复制全文</Button>
                    <Button onClick={() => void copyText(installationInstructions, "已复制安装说明。")}>复制安装说明</Button>
                  </div>
                </div>
                <div className="si-skill-access-grid">
                  <section><h3>读取</h3>{selectedSkill.reads.length ? <ul>{selectedSkill.reads.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : <p>不读取项目文件</p>}</section>
                  <section><h3>写入</h3>{selectedSkill.writes.length ? <ul>{selectedSkill.writes.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : <p>只读，不写入项目文件</p>}</section>
                </div>
                <pre className="si-skill-body" aria-label={`${selectedSkill.name} 正文`}>{selectedDetail.body}</pre>
              </section>

              <section className="si-skill-targets-card">
                <header><h2>安装位置 · {selectedSkill.name}</h2><Button size="small" onClick={() => void queryClient.invalidateQueries({ queryKey: ["skills", "targets", selectedSkillName] })} aria-label="刷新 Skill 安装位置"><RefreshCw size={14} /></Button></header>
                {targets.length === 0 ? <div className="si-skills-target-empty" role="status"><span>尚未配置 Skill 安装位置。</span><Link to="/settings"><Settings2 size={14} /> 管理平台目录</Link></div> : <div className="si-skill-target-list" role="list" aria-label="Skill 安装位置">
                  {targets.map((target) => <div className="si-skill-target-row" role="listitem" key={target.target_id}>
                    <strong>{target.name}</strong><code>{target.dir ?? "[首次使用时确认路径]"}</code><Chip tone={targetStatusTone(target.status)}>{targetStatusLabel(target.status)}</Chip>
                    {target.status === "unknown_path" ? <Link className="si-skill-target-action" to="/settings">设置目录 <ArrowUpRight size={13} /></Link> : <Button size="small" disabled={workingTarget === target.target_id} onClick={() => void installSkill(target)}>{workingTarget === target.target_id ? "处理中…" : installActionLabel(target.status)}</Button>}
                  </div>)}
                </div>}
                <footer><span>项目内的 Skill 写在 <code>_agent/skills/</code>，README 的任务路由指向它们，任何 agent 读 README 即可找到。</span><Link to="/settings" className="si-button">管理平台目录</Link></footer>
              </section>
            </>}
      </main>
    </div>}
  </div>;
}
