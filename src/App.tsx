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
import {
  LayoutDashboard,
  Archive,
  BookOpen,
  Settings as SettingsIcon,
  Newspaper,
  Upload,
  FileCode,
  ListChecks,
  Send,
  Menu,
  X,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { cn } from "./utils";

type View = "dashboard" | "archive" | "ai-content" | "leads" | "sdr" | "roadmap" | "methodology" | "system-docs" | "settings";
const ALL_VIEWS: View[] = ["dashboard", "archive", "ai-content", "leads", "sdr", "roadmap", "methodology", "system-docs", "settings"];

// Single source of truth for navigation. `primary` items render inline on desktop;
// the rest collapse into a "More" dropdown. The mobile drawer shows them all.
const NAV_ITEMS: { id: View; label: string; icon: LucideIcon; primary?: boolean }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, primary: true },
  { id: "sdr", label: "SDR", icon: Send, primary: true },
  { id: "leads", label: "Lead Import", icon: Upload, primary: true },
  { id: "ai-content", label: "AI Content", icon: Newspaper, primary: true },
  { id: "roadmap", label: "Roadmap", icon: ListChecks },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "methodology", label: "Methodology", icon: BookOpen },
  { id: "system-docs", label: "System Docs", icon: FileCode },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function NavButton({
  item, active, variant, onClick,
}: {
  item: { id: View; label: string; icon: LucideIcon };
  active: boolean;
  variant: "inline" | "menu" | "drawer";
  onClick: () => void;
}) {
  const Icon = item.icon;
  const base = "flex items-center gap-2 text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1";
  const cls =
    variant === "inline"
      ? cn(base, "px-4 py-2 rounded-xl", active ? "text-brand-600 bg-brand-50 shadow-sm shadow-brand-100/50" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50")
      : variant === "menu"
        ? cn(base, "w-full px-3 py-2 text-left rounded-lg", active ? "text-brand-600 bg-brand-50" : "text-slate-600 hover:bg-slate-50")
        : cn(base, "w-full px-3 py-2.5 rounded-xl", active ? "text-brand-600 bg-brand-50" : "text-slate-600 hover:bg-slate-50");
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined} className={cls}>
      <Icon className="h-4 w-4 flex-shrink-0" />
      {item.label}
    </button>
  );
}

function readViewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return ALL_VIEWS.includes(h as View) ? (h as View) : "dashboard";
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [view, setViewState] = useState<View>(() => readViewFromHash());
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { toasts, push, dismiss } = useToasts();

  // Keep URL hash in sync with view; allow back/forward to navigate
  const setView = (v: View) => {
    setViewState(v);
    if (window.location.hash !== `#/${v}`) {
      window.history.pushState(null, "", `#/${v}`);
    }
  };

  // Navigate + close any open nav surface
  const go = (v: View) => {
    setView(v);
    setMoreOpen(false);
    setMobileOpen(false);
  };

  // Escape closes the More dropdown / mobile drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMoreOpen(false); setMobileOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
            <div className="flex items-center gap-2 md:gap-4">
              {/* Desktop: primary items inline + collapsed overflow */}
              <nav className="hidden md:flex items-center gap-1" aria-label="Primary">
                {NAV_ITEMS.filter((i) => i.primary).map((item) => (
                  <NavButton key={item.id} item={item} active={view === item.id} variant="inline" onClick={() => go(item.id)} />
                ))}
                <div className="relative">
                  <button
                    onClick={() => setMoreOpen((o) => !o)}
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    className={cn(
                      "flex items-center gap-1 text-sm font-semibold px-4 py-2 rounded-xl transition-all duration-200",
                      NAV_ITEMS.some((i) => !i.primary && i.id === view)
                        ? "text-brand-600 bg-brand-50 shadow-sm shadow-brand-100/50"
                        : "text-slate-500 hover:text-slate-900 hover:bg-slate-50",
                    )}
                  >
                    More
                    <ChevronDown className={cn("h-4 w-4 transition-transform", moreOpen && "rotate-180")} />
                  </button>
                  {moreOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                      <div className="absolute right-0 mt-2 w-52 rounded-xl border border-slate-200 bg-white shadow-lg py-1 px-1 z-20" role="menu">
                        {NAV_ITEMS.filter((i) => !i.primary).map((item) => (
                          <NavButton key={item.id} item={item} active={view === item.id} variant="menu" onClick={() => go(item.id)} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </nav>
              <div className="h-6 w-px bg-slate-200 mx-1 hidden md:block" />
              <div className="flex items-center gap-3">
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-sm font-medium text-slate-700">
                    Admin User
                  </span>
                </div>
                <div className="h-9 w-9 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-sm border-2 border-white shadow-sm ring-1 ring-slate-200">
                  AD
                </div>
              </div>
              {/* Mobile: hamburger */}
              <button
                onClick={() => setMobileOpen(true)}
                aria-label="Open menu"
                className="md:hidden flex items-center justify-center h-9 w-9 rounded-xl text-slate-600 hover:bg-slate-100"
              >
                <Menu className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-72 max-w-[80%] bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-4 h-16 border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-900">Menu</span>
              <button
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="h-9 w-9 rounded-xl flex items-center justify-center text-slate-600 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-1" aria-label="Mobile">
              {NAV_ITEMS.map((item) => (
                <NavButton key={item.id} item={item} active={view === item.id} variant="drawer" onClick={() => go(item.id)} />
              ))}
            </nav>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {view === "dashboard" && (
          <Dashboard
            projects={projects}
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
      </main>
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

export default App;
