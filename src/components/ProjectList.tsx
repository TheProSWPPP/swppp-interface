import type { Project } from "../data";
import {
  Calendar,
  AlertCircle,
  MapPin,
  ChevronRight,
  Clock,
  Trash2,
} from "lucide-react";
import { cn } from "../utils";

interface ProjectListProps {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
}

const statusColors: Record<string, string> = {
  Processing: "bg-blue-50 text-blue-700 ring-blue-600/20",
  "Pending Review": "bg-amber-50 text-amber-700 ring-amber-600/20",
  Complete: "bg-green-50 text-green-700 ring-green-600/20",
  "Approved for Generation": "bg-purple-50 text-purple-700 ring-purple-600/20",
  New: "bg-gray-100 text-gray-700 ring-gray-600/20",
  "Manual Processing": "bg-orange-50 text-orange-700 ring-orange-600/20",
  "": "bg-gray-50 text-gray-600 ring-gray-500/10",
};

export default function ProjectList({
  projects,
  onSelectProject,
  onDeleteProject,
}: ProjectListProps) {
  return (
    <div className="space-y-6">
      <div className="bg-white px-6 py-5 rounded-xl border border-gray-200 shadow-sm">
        <h3 className="text-base font-semibold leading-6 text-gray-900">
          Project Queue
        </h3>
        <p className="mt-1 text-sm text-gray-500">
          Manage SWPPP document generation workflows.
        </p>
      </div>

      <ul className="space-y-4">
        {projects.map((project) => (
          <li
            key={project.id}
            onClick={() => onSelectProject(project)}
            className="group relative bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md hover:border-blue-300 cursor-pointer transition-all duration-200 ease-in-out overflow-hidden"
          >
            <div className="px-6 py-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0">
                    <div className="h-12 w-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-base border border-blue-100 group-hover:bg-blue-100 group-hover:border-blue-200 transition-colors">
                      {project.projectName.substring(0, 2).toUpperCase()}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <p className="text-base font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                        {project.projectName}
                      </p>
                      {project.specialRequirements.includes("24-Hour") && (
                        <span className="inline-flex items-center rounded-md bg-red-50 px-2 py-1 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-600/10">
                          <Clock className="h-3 w-3 mr-1" />
                          Urgent
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset",
                          statusColors[project.status] || statusColors[""]
                        )}
                      >
                        {project.status || "Draft"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        confirm("Are you sure you want to delete this project?")
                      ) {
                        onDeleteProject(project.id);
                      }
                    }}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete Project"
                  >
                    <Trash2 className="h-5 w-5" />
                  </button>
                  <ChevronRight className="h-5 w-5 text-gray-300 group-hover:text-blue-500 transition-colors" />
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500">
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-gray-400" />
                    <span className="truncate max-w-[200px]">
                      {project.email}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 hidden sm:flex">
                    <MapPin className="h-4 w-4 text-gray-400" />
                    <span>
                      {project.latitude}, {project.longitude}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-gray-400" />
                  <span
                    className={cn(
                      "font-medium",
                      new Date(project.dueDate) < new Date()
                        ? "text-red-600"
                        : "text-gray-700"
                    )}
                  >
                    Due {project.dueDate}
                  </span>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
