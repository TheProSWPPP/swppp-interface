import { useState } from "react";
import type { Project } from "../data";
import ProjectList from "./ProjectList";
import ProjectDetail from "./ProjectDetail";
import {
  BarChart3,
  CheckCircle2,
  Clock,
  AlertCircle,
  Inbox,
} from "lucide-react";
import { cn } from "../utils";

interface DashboardProps {
  projects: Project[];
  onUpdateProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
}

export default function Dashboard({
  projects,
  onUpdateProject,
  onDeleteProject,
}: DashboardProps) {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const stats = {
    total: projects.length,
    new: projects.filter((p) => p.status === "New").length,
    pending: projects.filter((p) => p.status === "Pending Review").length,
    processing: projects.filter(
      (p) => p.status === "Processing" || p.status === "Manual Processing"
    ).length,
    completed: projects.filter(
      (p) => p.status === "Approved for Generation" || p.status === "Complete"
    ).length,
  };

  return (
    <div className="space-y-8">
      {!selectedProject && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
              <Inbox className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">New Requests</p>
              <p className="text-2xl font-semibold text-gray-900">
                {stats.new}
              </p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">
                Pending Review
              </p>
              <p className="text-2xl font-semibold text-gray-900">
                {stats.pending}
              </p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600">
              <Clock className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Processing</p>
              <p className="text-2xl font-semibold text-gray-900">
                {stats.processing}
              </p>
            </div>
          </div>
          <div className="bg-white overflow-hidden rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-green-50 flex items-center justify-center text-green-600">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-500">Completed</p>
              <p className="text-2xl font-semibold text-gray-900">
                {stats.completed}
              </p>
            </div>
          </div>
        </div>
      )}

      {selectedProject ? (
        <ProjectDetail
          project={selectedProject}
          onBack={() => setSelectedProject(null)}
          onUpdate={(updated) => {
            onUpdateProject(updated);
            setSelectedProject(updated);
          }}
          onDelete={() => {
            onDeleteProject(selectedProject.id);
            setSelectedProject(null);
          }}
        />
      ) : (
        <ProjectList
          projects={projects}
          onSelectProject={setSelectedProject}
          onDeleteProject={onDeleteProject}
        />
      )}
    </div>
  );
}
