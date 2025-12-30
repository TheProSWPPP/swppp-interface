import { useState, useEffect } from "react";
import { type Project } from "./data";
import Dashboard from "./components/Dashboard";
import ArchiveList from "./components/ArchiveList";
import { FileText } from "lucide-react";
import { cn } from "./utils";

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<"dashboard" | "archive">("dashboard");

  const fetchProjects = () => {
    setIsLoading(true);
    fetch("/api/projects")
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
      prev.map((p) => (p.id === updatedProject.id ? updatedProject : p))
    );

    fetch(`/api/projects/${updatedProject.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedProject),
    }).catch((err) => console.error("Failed to update project:", err));
  };

  const handleDeleteProject = (projectId: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== projectId));

    fetch(`/api/projects/${projectId}`, {
      method: "DELETE",
    }).catch((err) => console.error("Failed to delete project:", err));
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
              <div className="bg-indigo-600 p-2 rounded-xl shadow-md shadow-indigo-200">
                <FileText className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-slate-900 tracking-tight">
                  SWPPP<span className="text-indigo-600">Doc</span>
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-2">
                <button
                  onClick={() => setView("dashboard")}
                  className={cn(
                    "text-sm font-medium px-3 py-1.5 rounded-full transition-colors",
                    view === "dashboard"
                      ? "text-indigo-600 bg-indigo-50"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  )}
                >
                  Dashboard
                </button>
                <button
                  onClick={() => setView("archive")}
                  className={cn(
                    "text-sm font-medium px-3 py-1.5 rounded-full transition-colors",
                    view === "archive"
                      ? "text-indigo-600 bg-indigo-50"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  )}
                >
                  Archive
                </button>
                <a
                  href="#"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-full hover:bg-slate-50 transition-colors"
                >
                  Settings
                </a>
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
        {view === "dashboard" ? (
          <Dashboard
            projects={projects}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
          />
        ) : (
          <ArchiveList onRestore={fetchProjects} />
        )}
      </main>
    </div>
  );
}

export default App;
