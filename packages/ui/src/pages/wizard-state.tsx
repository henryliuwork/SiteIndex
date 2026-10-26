import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { DetectResult, FeedInspectResult, SiteConfig } from "@siteindex/shared";

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
  created: { id: string; runId: string; path: string | null } | null;
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
  const reset = useCallback(() => setDraft({ ...initialDraft, brand: { ...initialDraft.brand, usp: [] } }), []);
  const value = useMemo(() => ({ draft, update, reset }), [draft, update, reset]);
  return <WizardDraftContext.Provider value={value}>{children}</WizardDraftContext.Provider>;
}

export function useWizardDraft(): WizardDraftContextValue {
  const value = useContext(WizardDraftContext);
  if (!value) throw new Error("新建向导必须在 WizardDraftProvider 内运行。");
  return value;
}
