import { useState } from "react";
import type { Project } from "../data";
import {
  Calendar,
  AlertCircle,
  ChevronRight,
  Clock,
  Trash2,
  FileCode,
  CheckCircle,
  Zap,
  Printer,
  ShieldCheck,
  Globe,
} from "lucide-react";
import { cn, formatGeorgiaTime } from "../utils";
import { getTemplateName } from "../templates";
import { motion, AnimatePresence } from "framer-motion";

interface ProjectListProps {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onBulkDeleteProjects: (projectIds: string[]) => void;
}

const statusColors: Record<string, string> = {
  Processing: "bg-blue-50 text-blue-700 border-blue-200",
  "Pending Review": "bg-amber-50 text-amber-700 border-amber-200",
  Complete: "bg-green-50 text-green-700 border-green-200",
  "Approved for Generation": "bg-indigo-50 text-indigo-700 border-indigo-200",
  Ready: "bg-emerald-50 text-emerald-700 border-emerald-200",
  New: "bg-slate-100 text-slate-700 border-slate-200",
  "Manual Processing": "bg-orange-50 text-orange-700 border-orange-200",
  "": "bg-slate-50 text-slate-600 border-slate-200",
};

export default function ProjectList({
  projects,
  onSelectProject,
  onDeleteProject,
  onBulkDeleteProjects,
}: ProjectListProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleBulkDelete = () => {
    if (
      confirm(`Are you sure you want to delete ${selectedIds.length} projects?`)
    ) {
      onBulkDeleteProjects(selectedIds);
      setSelectedIds([]);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-2xl font-bold text-slate-900 tracking-tight">
            Project Queue
          </h3>
          <p className="mt-1 text-sm text-slate-500 font-medium">
            Manage document generation workflows and job orders.
          </p>
        </div>

        <AnimatePresence>
          {selectedIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex items-center gap-4 bg-white border border-slate-200 px-4 py-2 rounded-2xl shadow-lg"
            >
              <span className="text-sm font-bold text-slate-700">
                {selectedIds.length} Selected
              </span>
              <div className="h-4 w-px bg-slate-200" />
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-2 text-sm font-bold text-red-600 hover:text-red-700 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                Delete Selected
              </button>
              <button
                onClick={() => setSelectedIds([])}
                className="text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors"
              >
                Cancel
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <AnimatePresence mode="popLayout">
          {projects.map((project) => (
            <motion.div
              layout
              key={project.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
              onClick={() => onSelectProject(project)}
              className={cn(
                "group relative bg-white rounded-3xl border transition-all duration-300 cursor-pointer overflow-hidden p-1",
                selectedIds.includes(project.id)
                  ? "border-indigo-500 shadow-indigo-100 shadow-lg ring-1 ring-indigo-500"
                  : "border-slate-200 shadow-sm hover:shadow-xl hover:shadow-indigo-500/5 hover:-translate-y-0.5"
              )}
            >
              <div className="bg-white rounded-[1.4rem] p-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-5">
                    <div className="flex-shrink-0 relative group/check">
                      <div
                        onClick={(e) => toggleSelect(project.id, e)}
                        className={cn(
                          "absolute -top-2 -left-2 z-10 p-1.5 rounded-full border transition-all duration-200 opacity-0 group-hover/check:opacity-100",
                          selectedIds.includes(project.id)
                            ? "bg-indigo-600 border-indigo-600 text-white opacity-100"
                            : "bg-white border-slate-200 text-slate-400 hover:border-indigo-400"
                        )}
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                      </div>
                      <div className="h-14 w-14 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-600 font-black text-lg border border-slate-100 group-hover:bg-indigo-600 group-hover:text-white group-hover:border-indigo-600 transition-all duration-300 shadow-inner">
                        {project.projectName.substring(0, 2).toUpperCase()}
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <h4 className="text-lg font-bold text-slate-900 group-hover:text-indigo-600 transition-colors leading-snug">
                          {project.projectName}
                        </h4>
                        {project["24hrTurnaround"] === "yes" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-[10px] font-bold text-red-700 border border-red-100 uppercase tracking-wider">
                            <Zap className="h-3 w-3" />
                            24hr Turnaround
                          </span>
                        )}
                        {project.needHardCopy === "yes" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold text-amber-700 border border-amber-100 uppercase tracking-wider">
                            <Printer className="h-3 w-3" />
                            Hard Copy
                          </span>
                        )}
                        {project.certifiedInspection === "yes" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-[10px] font-bold text-blue-700 border border-blue-100 uppercase tracking-wider">
                            <ShieldCheck className="h-3 w-3" />
                            Certified
                          </span>
                        )}
                        {project.eportalAccess === "yes" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-100 uppercase tracking-wider">
                            <Globe className="h-3 w-3" />
                            E-Portal
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-2">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider border",
                            statusColors[project.status] || statusColors[""]
                          )}
                        >
                          {project.status || "Draft"}
                        </span>
                        {new Date().getTime() -
                          new Date(project.dateReceived).getTime() <
                          24 * 60 * 60 * 1000 && (
                          <span className="inline-flex items-center rounded-full bg-blue-600 px-2.5 py-0.5 text-[10px] font-black text-white uppercase tracking-widest shadow-sm shadow-blue-200">
                            New
                          </span>
                        )}
                        {(project.stateTemplateId ||
                          project.stateTemplateName) && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-[11px] font-bold text-indigo-600 border border-indigo-100 uppercase tracking-wider shadow-sm">
                            <FileCode className="h-3 w-3" />
                            {getTemplateName(
                              project.stateTemplateId ||
                                project.stateTemplateName
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          confirm(
                            "Are you sure you want to delete this project?"
                          )
                        ) {
                          onDeleteProject(project.id);
                        }
                      }}
                      className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-2xl transition-all duration-200 opacity-0 group-hover:opacity-100"
                      title="Delete Project"
                    >
                      <Trash2 className="h-5 w-5" />
                    </button>
                    <div className="p-2 text-slate-300 group-hover:text-indigo-500 transition-colors">
                      <ChevronRight className="h-6 w-6" />
                    </div>
                  </div>
                </div>

                <div className="mt-8 pt-6 border-t border-slate-50 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-8">
                    <div className="flex items-center gap-2.5 text-slate-500 group-hover:text-slate-700 transition-colors">
                      <div className="p-1.5 rounded-lg bg-slate-50 border border-slate-100 group-hover:bg-white transition-colors">
                        <AlertCircle className="h-4 w-4" />
                      </div>
                      <span className="font-medium tracking-tight">
                        {project.email}
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5 text-slate-500 group-hover:text-slate-700 transition-colors hidden lg:flex">
                      <div className="p-1.5 rounded-lg bg-slate-50 border border-slate-100 group-hover:bg-white transition-colors">
                        <Calendar className="h-4 w-4" />
                      </div>
                      <span className="font-medium tracking-tight">
                        {formatGeorgiaTime(project.dateReceived)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {new Date(project.dueDate).toDateString() ===
                      new Date(
                        new Date().getTime() + 24 * 60 * 60 * 1000
                      ).toDateString() && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-[11px] font-black text-red-700 border border-red-200 uppercase tracking-tighter shadow-sm animate-pulse">
                        <Clock className="h-3 w-3" />
                        Tomorrow
                      </span>
                    )}
                    <div
                      className={cn(
                        "p-2 rounded-2xl border transition-all duration-300 flex items-center gap-2.5 px-4",
                        new Date(project.dueDate) < new Date()
                          ? "bg-red-50 border-red-100 text-red-700 shadow-sm shadow-red-100"
                          : "bg-slate-50 border-slate-100 text-slate-600"
                      )}
                    >
                      <Clock className="h-4 w-4" />
                      <span className="font-bold tracking-tight text-xs uppercase">
                        Due {project.dueDate}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
