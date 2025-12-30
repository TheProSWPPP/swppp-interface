import { useState, useEffect } from "react";
import { Calendar, RotateCcw, AlertCircle } from "lucide-react";
import { cn } from "../utils";

interface ArchiveListProps {
  onRestore: () => void;
}

export default function ArchiveList({ onRestore }: ArchiveListProps) {
  const [archive, setArchive] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/archive")
      .then((res) => res.json())
      .then((data) => {
        setArchive(data);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch archive:", err);
        setIsLoading(false);
      });
  }, []);

  const handleRestore = (id: string) => {
    if (confirm("Restore this project to the active queue?")) {
      fetch(`/api/archive/${id}/restore`, { method: "POST" })
        .then((res) => {
          if (res.ok) {
            setArchive((prev) => prev.filter((p) => p.id !== id));
            onRestore();
          }
        })
        .catch((err) => console.error("Failed to restore project:", err));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500">
        Loading archive...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white px-6 py-5 rounded-xl border border-slate-200 shadow-sm">
        <h3 className="text-base font-semibold leading-6 text-slate-900">
          Archived Projects
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Projects are automatically permanently deleted 30 days after being
          archived.
        </p>
      </div>

      {archive.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
          <p className="text-slate-500">No archived projects found.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {archive.map((project) => (
            <li
              key={project.id}
              className="bg-slate-50 rounded-xl border border-slate-200 p-5 flex items-center justify-between opacity-75 hover:opacity-100 transition-opacity"
            >
              <div className="flex items-center gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 font-bold text-sm">
                    {project.projectName.substring(0, 2).toUpperCase()}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {project.projectName}
                  </p>
                  <div className="flex items-center gap-4 mt-1 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {project.email}
                    </span>
                    {project.deletedAt && (
                      <span className="flex items-center gap-1 text-orange-600 font-medium">
                        <Calendar className="h-3 w-3" />
                        Deleted:{" "}
                        {new Date(project.deletedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <button
                onClick={() => handleRestore(project.id)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-indigo-600 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors shadow-sm"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
