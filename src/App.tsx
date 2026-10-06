import { useState, useEffect } from "react";
import { type Project } from "./data";
import Dashboard from "./components/Dashboard";
import ArchiveList from "./components/ArchiveList";
import Methodology from "./components/Methodology";
import SettingsView from "./components/Settings";
import AIContent from "./components/AIContent";
import LeadUpload from "./components/LeadUpload";
import SystemDocs from "./components/SystemDocs";
import AutomationRoadmap from "./components/AutomationRoadmap";
import SdrInterface from "./components/SdrInterface";
import { useToasts, ToastStack } from "./components/Toast";
import WorkspaceChrome from "./components/workspace/WorkspaceChrome";
import SalesPage from "./components/workspace/SalesPage";
import InterfaceReview from "./components/workspace/InterfaceReview";
import { readWorkspaceView, type WorkspaceView } from "./components/workspace/navigation";
import { getUser, getToken, type SdrUser } from "./lib/sdrApi";
import "./components/workspace/workspace.css";

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [view, setViewState] = useState<WorkspaceView>(() => readWorkspaceView(window.location.hash));
  const [user, setUser] = useState<SdrUser | null>(() => getToken() ? getUser() : null);
  const { toasts, push, dismiss } = useToasts();

  // Keep URL hash in sync with view; allow back/forward to navigate
  const setView = (v: WorkspaceView) => {
    setViewState(v);
    if (window.location.hash !== `#/${v}`) {
      window.history.pushState(null, "", `#/${v}`);
    }
  };

  // Navigate + close any open nav surface
  const go = (v: WorkspaceView) => {
    setView(v);
    setUser(getToken() ? getUser() : null);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  useEffect(() => {
    const sync = () => setUser(getToken() ? getUser() : null);
    window.addEventListener("sdr-session-changed", sync);
    window.addEventListener("sdr-session-expired", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("sdr-session-changed", sync);
      window.removeEventListener("sdr-session-expired", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    const onPop = () => setViewState(readWorkspaceView(window.location.hash));
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    // Ensure hash reflects initial state
    if (!window.location.hash || readWorkspaceView(window.location.hash) !== view) {
      window.history.replaceState(null, "", `#/${view}`);
    }
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchProjects = () => {
    setIsLoading(true);
    setLoadError(false);
    fetch("/api/projects", {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setProjects(Array.isArray(data) ? data : []);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch projects:", err);
        setLoadError(true);
        setIsLoading(false);
      });
  };

  useEffect(() => {
    if (view === "dashboard") fetchProjects();
  }, [view]);

  const handleUpdateProject = (updatedProject: Project) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === updatedProject.id ? updatedProject : p)),
    );

    fetch(`/api/projects/${updatedProject.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(updatedProject),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
      .catch((err) => {
        console.error("Failed to update project:", err);
        push(
          "error",
          "Couldn't save your changes — they may not have persisted. Check your connection and try again.",
        );
      });
  };

  const handleDeleteProject = (projectId: string) => {
    const prevProjects = projects;
    setProjects((prev) => prev.filter((p) => p.id !== projectId));

    fetch(`/api/projects/${projectId}`, {
      method: "DELETE",
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
      .catch((err) => {
        console.error("Failed to delete project:", err);
        setProjects(prevProjects); // restore — the delete didn't take
        push("error", "Couldn't archive that project — it's still in the queue.");
      });
  };

  const handleBulkDeleteProjects = (projectIds: string[]) => {
    const prevProjects = projects;
    setProjects((prev) => prev.filter((p) => !projectIds.includes(p.id)));

    fetch("/api/projects/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ ids: projectIds }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
      .catch((err) => {
        console.error("Failed to bulk delete projects:", err);
        setProjects(prevProjects); // restore — the delete didn't take
        push(
          "error",
          `Couldn't archive the selected project${projectIds.length === 1 ? "" : "s"} — still in the queue.`,
        );
      });
  };

  return (
    <WorkspaceChrome view={view} user={user} onNavigate={go}>
        {view === "sales" && <SalesPage key={user?.id || "signed-out"} user={user} onOpenSdr={() => go("sdr")} />}
        {view === "interface-review" && import.meta.env.DEV && <InterfaceReview onNavigate={go} />}
        {view === "dashboard" && (
          <Dashboard
            projects={projects}
            isLoading={isLoading}
            loadError={loadError}
            onRetry={fetchProjects}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
            onBulkDeleteProjects={handleBulkDeleteProjects}
          />
        )}
        {view === "archive" && <ArchiveList onRestore={fetchProjects} />}
        {view === "ai-content" && <AIContent />}
        {view === "leads" && <LeadUpload />}
        {view === "sdr" && <SdrInterface />}
        {view === "roadmap" && <AutomationRoadmap />}
        {view === "methodology" && <Methodology />}
        {view === "system-docs" && <SystemDocs />}
        {view === "settings" && <SettingsView />}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </WorkspaceChrome>
  );
}

export default App;
