import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { DetectResult, FeedInspectResult, SiteConfig } from "@siteindex/shared";

export const defaultWorkspaceFolders = [
  { name: "seo", description: "关键词研究、排名记录、站内优化" },
  { name: "edm", description: "每次邮件一个子文件夹" },
  { name: "产品", description: "产品图、上新资料、利润测算" },
  { name: "内容", description: "博客 brief 与草稿" },
  { name: "设计", description: "页面、Banner、邮件模板设计稿" },
  { name: "报告", description: "月度汇报、复盘" },
];

export interface WizardDraft {
  url: string;
  detect: DetectResult | null;
  feedUrls: string[];
  feedResult: FeedInspectResult | null;
  skuField: string;
  categoryDepth: number;
  missingAs: "out_of_stock" | "removed";
  brand: SiteConfig["brand"];
  market: string;
  projectsRoot: string;
  folderName: string;
  workspaceFolders: string[];
  created: { id: string; runId: string } | null;
}

const initialDraft: WizardDraft = {
  url: "kingsyard.com",
  detect: null,
  feedUrls: [],
  feedResult: null,
  skuField: "id",
  categoryDepth: 2,
  missingAs: "out_of_stock",
  brand: { name: "", tagline: "", audience: "", voice: "", usp: [] },
  market: "US",
  projectsRoot: "",
  folderName: "",
  workspaceFolders: defaultWorkspaceFolders.map((folder) => folder.name),
  created: null,
};

interface WizardDraftContextValue {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
  reset: () => void;
}

const WizardDraftContext = createContext<WizardDraftContextValue | null>(null);

export function WizardDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(initialDraft);
  const update = useCallback((patch: Partial<WizardDraft>) => setDraft((current) => ({ ...current, ...patch })), []);
  const reset = useCallback(() => setDraft({ ...initialDraft, brand: { ...initialDraft.brand, usp: [] }, workspaceFolders: initialDraft.workspaceFolders.slice() }), []);
  const value = useMemo(() => ({ draft, update, reset }), [draft, update, reset]);
  return <WizardDraftContext.Provider value={value}>{children}</WizardDraftContext.Provider>;
}

export function useWizardDraft(): WizardDraftContextValue {
  const value = useContext(WizardDraftContext);
  if (!value) throw new Error("新建向导必须在 WizardDraftProvider 内运行。");
  return value;
}
