import type {ProjectSaver} from '../projectPersistence';
import { useState, useEffect } from "react";
import type { Project } from "../data";
import ProjectList from "./ProjectList";
import ProjectDetail from "./ProjectDetail";
import { AlertCircle, RotateCcw } from "lucide-react";
import { StatCardsSkeleton, ListRowsSkeleton, Skeleton } from "./Skeleton";

interface DashboardProps {
  projects: Project[];
  isLoading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  onUpdateProject: ProjectSaver;
  onDeleteProject: (projectId: string) => void;
  onBulkDeleteProjects: (projectIds: string[]) => void;
}

export default function Dashboard({
  projects,
  isLoading,
  loadError,
  onRetry,
  onUpdateProject,
  onDeleteProject,
  onBulkDeleteProjects,
}: DashboardProps) {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  // Restore selected project from URL hash on load / projects change
  useEffect(() => {
    const match = window.location.hash.match(/^#project-(.+)$/);
    if (match) {
      const found = projects.find((p) => p.id === match[1]);
      if (found) setSelectedProject(found);
    }
  }, [projects]);

  // Sync hash with browser back button
  useEffect(() => {
    const handlePop = () => {
      const match = window.location.hash.match(/^#project-(.+)$/);
      if (match) {
        const found = projects.find((p) => p.id === match[1]);
        setSelectedProject(found ?? null);
      } else {
        setSelectedProject(null);
      }
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [projects]);

  const openProject = (project: Project) => {
    setSelectedProject(project);
    window.location.hash = `project-${project.id}`;
  };

  const closeProject = () => {
    setSelectedProject(null);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  };

  if (isLoading && !selectedProject && projects.length === 0) {
    return (
      <div className="space-y-8">
        <StatCardsSkeleton count={4} />
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-11 w-full rounded-xl" />
        <ListRowsSkeleton rows={4} />
      </div>
    );
  }

  if (loadError && !selectedProject) {
    return (
      <div className="flex flex-col items-center justify-center text-center py-20">
        <div className="h-12 w-12 rounded-full bg-red-50 flex items-center justify-center text-red-500 mb-4">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h3 className="text-lg font-bold text-slate-900">
          Couldn't load projects
        </h3>
        <p className="mt-1 max-w-sm text-sm text-slate-500">
          The project queue could not be loaded. Retry to check the connection.
        </p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 transition-colors"
          >
            <RotateCcw className="h-4 w-4" />
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {selectedProject ? (
        <ProjectDetail
          project={selectedProject}
          onBack={closeProject}
          onUpdate={async (updated, expected) => {
            try {
              const authoritative = await onUpdateProject(updated, expected);
              if (authoritative) setSelectedProject(authoritative);
              return authoritative;
            } catch (error) {
              const failure = error as Error & { project?: Project };
              if (failure.project?.id === updated.id) setSelectedProject(failure.project);
              throw error;
            }
          }}
          onDelete={() => {
            onDeleteProject(selectedProject.id);
            closeProject();
          }}
        />
      ) : (
        <ProjectList
          projects={projects}
          onSelectProject={openProject}
          onDeleteProject={onDeleteProject}
          onBulkDeleteProjects={onBulkDeleteProjects}
        />
      )}
    </div>
  );
}
