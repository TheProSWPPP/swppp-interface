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
import {
  LayoutDashboard,
  Archive,
  BookOpen,
  Settings as SettingsIcon,
  Newspaper,
  Upload,
  FileCode,
  ListChecks,
} from "lucide-react";
import { cn } from "./utils";

type View = "dashboard" | "archive" | "ai-content" | "leads" | "roadmap" | "methodology" | "system-docs" | "settings";
const ALL_VIEWS: View[] = ["dashboard", "archive", "ai-content", "leads", "roadmap", "methodology", "system-docs", "settings"];

function readViewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return ALL_VIEWS.includes(h as View) ? (h as View) : "dashboard";
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setViewState] = useState<View>(() => readViewFromHash());

  // Keep URL hash in sync with view; allow back/forward to navigate
  const setView = (v: View) => {
    setViewState(v);
    if (window.location.hash !== `#/${v}`) {
      window.history.pushState(null, "", `#/${v}`);
    }
  };

  useEffect(() => {
    const onPop = () => setViewState(readViewFromHash());
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    // Ensure hash reflects initial state
    if (!window.location.hash || readViewFromHash() !== view) {
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
    fetch("/api/projects", {
      credentials: "include",
    })
      .then((res) => res.json())
      .then((data) => {
        setProjects(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch projects:", err);
        setIsLoading(false);
      });
  };

  useEffect(() => {
    fetchProjects();
  }, []);

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
    }).catch((err) => console.error("Failed to update project:", err));
  };

  const handleDeleteProject = (projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));

    fetch(`/api/projects/${projectId}`, {
      method: "DELETE",
      credentials: "include",
    }).catch((err) => console.error("Failed to delete project:", err));
  };

  const handleBulkDeleteProjects = (projectIds: string[]) => {
    setProjects((prev) => prev.filter((p) => !projectIds.includes(p.id)));

    fetch("/api/projects/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ ids: projectIds }),
    }).catch((err) => console.error("Failed to bulk delete projects:", err));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-slate-500">
        Loading projects...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-3">
              <img
                src="/logo.webp"
                alt="Pro SWPPP Logo"
                className="h-10 w-auto"
              />
            </div>
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-1">
                <button
                  onClick={() => setView("dashboard")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "dashboard"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <LayoutDashboard className="h-4 w-4" />
                  Dashboard
                </button>
                <button
                  onClick={() => setView("archive")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "archive"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <Archive className="h-4 w-4" />
                  Archive
                </button>
                <button
                  onClick={() => setView("ai-content")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "ai-content"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <Newspaper className="h-4 w-4" />
                  AI Content
                </button>
                <button
                  onClick={() => setView("leads")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "leads"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <Upload className="h-4 w-4" />
                  Lead Import
                </button>
                <button
                  onClick={() => setView("roadmap")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "roadmap"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <ListChecks className="h-4 w-4" />
                  Roadmap
                </button>
                <button
                  onClick={() => setView("methodology")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "methodology"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <BookOpen className="h-4 w-4" />
                  Methodology
                </button>
                <button
                  onClick={() => setView("system-docs")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "system-docs"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <FileCode className="h-4 w-4" />
                  System Docs
                </button>
                <button
                  onClick={() => setView("settings")}
                  className={cn(
                    "flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                    view === "settings"
                      ? "text-indigo-600 bg-indigo-50 shadow-sm shadow-indigo-100/50"
                      : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                  )}
                >
                  <SettingsIcon className="h-4 w-4" />
                  Settings
                </button>
              </nav>
              <div className="h-6 w-px bg-slate-200 mx-2 hidden md:block" />
              <div className="flex items-center gap-3">
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-sm font-medium text-slate-700">
                    Admin User
                  </span>
                </div>
                <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-sm border-2 border-white shadow-sm ring-1 ring-slate-200">
                  AD
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {view === "dashboard" && (
          <Dashboard
            projects={projects}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
            onBulkDeleteProjects={handleBulkDeleteProjects}
          />
        )}
        {view === "archive" && <ArchiveList onRestore={fetchProjects} />}
        {view === "ai-content" && <AIContent />}
        {view === "leads" && <LeadUpload />}
        {view === "roadmap" && <AutomationRoadmap />}
        {view === "methodology" && <Methodology />}
        {view === "system-docs" && <SystemDocs />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

export default App;
