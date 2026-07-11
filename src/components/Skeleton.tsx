import { cn } from "../utils";

// A single shimmering placeholder block. Compose these to mirror the shape of
// the content that's loading, so a load reads as "content on its way" rather
// than a broken empty screen.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-slate-200/70", className)}
    />
  );
}

// Row of stat cards — matches the Dashboard / AI Content stat strip.
export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex items-center gap-4"
        >
          <Skeleton className="h-12 w-12 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}

// A few placeholder list rows.
export function ListRowsSkeleton({
  rows = 3,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex items-center gap-5"
        >
          <Skeleton className="h-14 w-14 rounded-2xl" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      ))}
    </div>
  );
}
