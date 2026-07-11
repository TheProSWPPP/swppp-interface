import { useState, useEffect } from "react";
import { Calendar, RotateCcw, AlertCircle } from "lucide-react";
import { ListRowsSkeleton, Skeleton } from "./Skeleton";

interface ArchiveListProps {
  onRestore: () => void;
}

export default function ArchiveList({ onRestore }: ArchiveListProps) {
  const [archive, setArchive] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchArchive = () => {
    setIsLoading(true);
    setLoadError(false);
    fetch("/api/archive")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setArchive(Array.isArray(data) ? data : []);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch archive:", err);
        setLoadError(true);
        setIsLoading(false);
      });
  };

  useEffect(() => {
    fetchArchive();
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
      <div className="space-y-6">
        <div className="bg-white px-6 py-5 rounded-xl border border-slate-200 shadow-sm space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-80" />
        </div>
        <ListRowsSkeleton rows={3} />
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

      {loadError ? (
        <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
          <div className="mx-auto mb-3 h-10 w-10 rounded-full bg-red-50 flex items-center justify-center text-red-500">
            <AlertCircle className="h-5 w-5" />
          </div>
          <p className="text-slate-700 font-medium">Couldn't load the archive</p>
          <p className="mt-1 text-sm text-slate-500">
            Connection issue — nothing was lost.
          </p>
          <button
            onClick={fetchArchive}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : archive.length === 0 ? (
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
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-brand-600 bg-white border border-brand-200 rounded-lg hover:bg-brand-50 transition-colors shadow-sm"
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
