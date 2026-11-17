import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { DetectResult, FeedInspectResult, SiteConfig, WorkspaceCreateInput } from "@siteindex/shared";

export interface WizardDraft {
  url: string;
  detect: DetectResult | null;
  feedUrls: string[];
  feedResult: FeedInspectResult | null;
  feedSkipped: boolean;
  categoryRules: string;
  skuField: string;
  categoryDepth: number;
  missingAs: "out_of_stock" | "removed";
  brand: SiteConfig["brand"];
  market: string;
  projectsRoot: string;
  folderName: string;
  workspaceEnabled: boolean;
  workspacePlatform: WorkspaceCreateInput["platform"];
  workspaceEspPresets: string[];
  created: { id: string; runId: string; path: string | null } | null;
}

const initialDraft: WizardDraft = {
  url: "shop.example.test",
  detect: null,
  feedUrls: [],
  feedResult: null,
  feedSkipped: false,
  categoryRules: "",
  skuField: "id",
  categoryDepth: 2,
  missingAs: "out_of_stock",
  brand: { name: "", tagline: "", audience: "", voice: "", usp: [] },
  market: "US",
  projectsRoot: "",
  folderName: "",
  workspaceEnabled: true,
  workspacePlatform: "other",
  workspaceEspPresets: ["mailchimp"],
  created: null,
};

interface WizardDraftContextValue {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft> | ((current: WizardDraft) => Partial<WizardDraft>)) => void;
  reset: () => void;
}

const WizardDraftContext = createContext<WizardDraftContextValue | null>(null);

export function WizardDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(initialDraft);
  const update = useCallback((patch: Partial<WizardDraft> | ((current: WizardDraft) => Partial<WizardDraft>)) => setDraft((current) => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) })), []);
  const reset = useCallback(() => setDraft({ ...initialDraft, brand: { ...initialDraft.brand, usp: [] } }), []);
  const value = useMemo(() => ({ draft, update, reset }), [draft, update, reset]);
  return <WizardDraftContext.Provider value={value}>{children}</WizardDraftContext.Provider>;
}

export function useWizardDraft(): WizardDraftContextValue {
  const value = useContext(WizardDraftContext);
  if (!value) throw new Error("新建向导必须在 WizardDraftProvider 内运行。");
  return value;
}
