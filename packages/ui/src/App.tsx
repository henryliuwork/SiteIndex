import { useQuery } from "@tanstack/react-query";
import { HashRouter, Route, Routes, type RouteObject } from "react-router-dom";
import { api } from "./api";
import { SideNav, WindowChrome } from "./components";
import { WizardDraftProvider } from "./pages/wizard-state";

const pageRoutes = Object.values(import.meta.glob<RouteObject>("./pages/*/route.tsx", { eager: true, import: "route" }));

function AppShell() {
  const platform = useQuery({ queryKey: ["app", "platform"], queryFn: () => api.app.platform() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects.list() });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.settings.get() });
  const navProjects = projects.data?.map(({ id, name, sync }) => ({ id, name, state: sync.state })) ?? [{ id: "kingsyard", name: "Kingsyard", state: "partial" as const }];
  const runnerProject = projects.data?.find((project) => project.is_runner);
  return (
    <WindowChrome platform={platform.data ?? "win32"}>
      <div className="si-layout">
        <SideNav projects={navProjects} deviceName={settings.data?.device_name} runnerProject={runnerProject?.name} />
        <main className="si-content">
          <WizardDraftProvider>
          <Routes>{pageRoutes.map((pageRoute, index) => <Route key={pageRoute.path ?? `page-${index}`} path={pageRoute.path} element={pageRoute.element} />)}</Routes>
          </WizardDraftProvider>
        </main>
      </div>
    </WindowChrome>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
