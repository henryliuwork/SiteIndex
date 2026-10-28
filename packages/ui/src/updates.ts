import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorMessage } from "./api";
import { projectQueryKeys } from "./project-queries";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "unsupported";

export interface UpdateStatus {
  state: UpdateState;
  current: string;
  latest?: string;
  percent?: number;
  notes?: string;
  error?: string;
  manual_url?: string;
}

export interface UpdatesApi {
  check(): Promise<UpdateStatus>;
  download(): Promise<void>;
  install(): Promise<void>;
  onStatus(callback: (status: UpdateStatus) => void): () => void;
}

export type UpdateAction = "check" | "download" | "install";

function isUpdatesApi(value: unknown): value is UpdatesApi {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["check", "download", "install", "onStatus"].every((method) => typeof candidate[method] === "function");
}

export function getUpdatesApi(): UpdatesApi | undefined {
  const candidate = (api as unknown as { updates?: unknown }).updates;
  return isUpdatesApi(candidate) ? candidate : undefined;
}

export function displayVersion(version?: string | null): string {
  const stableVersion = version?.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
  return stableVersion || "…";
}

export function updateStatusLabel(status: UpdateStatus | undefined, loading = false): string {
  if (!status) return loading ? "正在检查更新…" : "尚未检查更新";
  switch (status.state) {
    case "idle": return status.latest ? "已是最新版本" : "没有可用更新";
    case "checking": return "正在检查更新…";
    case "available": return `有新版本 v${displayVersion(status.latest)}`;
    case "downloading": return `正在下载 ${Math.max(0, Math.min(100, status.percent ?? 0))}%`;
    case "ready": return "新版本已就绪";
    case "unsupported": return `有新版本 v${displayVersion(status.latest)}`;
    case "error": return "检查更新失败";
  }
}

export function useUpdatesController() {
  const updates = getUpdatesApi();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<UpdateAction | null>(null);
  const query = useQuery({
    queryKey: ["updates", "status"],
    queryFn: () => updates!.check(),
    enabled: Boolean(updates),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!updates) return;
    return updates.onStatus((next) => queryClient.setQueryData(["updates", "status"], next));
  }, [updates, queryClient]);

  const status = query.data ?? (query.isError ? { state: "error" as const, current: "" } : undefined);

  const run = async (action: UpdateAction) => {
    if (!updates || busy) return;
    setBusy(action);
    try {
      if (action === "check") {
        const result = await query.refetch();
        if (result.isError) throw result.error;
      }
      else await updates[action]();
    } catch (cause) {
      queryClient.setQueryData<UpdateStatus>(["updates", "status"], (previous) => ({
        state: "error",
        current: previous?.current ?? "",
        latest: previous?.latest,
        notes: previous?.notes,
        manual_url: previous?.manual_url,
        error: apiErrorMessage(cause, "请稍后重试。"),
      }));
    } finally {
      setBusy(null);
    }
  };

  return { updates, status, busy, run, query };
}

export function useAnyRunningJob(enabled: boolean) {
  const projectsQuery = useQuery({ queryKey: projectQueryKeys.list, queryFn: () => api.projects.list() });
  const runningQuery = useQuery({
    queryKey: ["updates", "running-jobs", projectsQuery.data?.map(({ id }) => id)],
    enabled: enabled && projectsQuery.isSuccess,
    queryFn: async () => {
      const projects = projectsQuery.data ?? [];
      const running = await Promise.all(projects.map((project) => api.jobs.running(project.id)));
      return running.some(Boolean);
    },
    refetchInterval: enabled ? 1000 : false,
  });
  return { ...runningQuery, projectsQuery };
}
