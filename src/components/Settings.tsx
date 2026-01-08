import {
  Settings as SettingsIcon,
  ShieldCheck,
  Database,
  Server,
} from "lucide-react";

export default function Settings() {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 lg:p-12 overflow-hidden relative">
        <div className="absolute top-0 right-0 p-8 opacity-5">
          <SettingsIcon className="h-32 w-32" />
        </div>

        <div className="relative z-10">
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
            System Settings
          </h1>
          <p className="text-slate-500 mb-12 font-medium">
            Configure system-wide parameters and integrations.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-6 rounded-2xl border border-slate-100 bg-slate-50/50 space-y-4 opacity-60 grayscale cursor-not-allowed group transition-all">
              <div className="h-10 w-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-400">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-1">
                  Authentication
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Manage administrator credentials and access control lists.
                </p>
              </div>
              <span className="inline-flex text-[10px] font-black bg-slate-900 text-white px-2 py-0.5 rounded uppercase tracking-tighter">
                Coming Soon
              </span>
            </div>

            <div className="p-6 rounded-2xl border border-slate-100 bg-slate-50/50 space-y-4 opacity-60 grayscale cursor-not-allowed group transition-all">
              <div className="h-10 w-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-400">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-1">
                  Database
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Connection strings and automated backup configurations.
                </p>
              </div>
              <span className="inline-flex text-[10px] font-black bg-slate-900 text-white px-2 py-0.5 rounded uppercase tracking-tighter">
                Coming Soon
              </span>
            </div>

            <div className="p-6 rounded-2xl border border-slate-100 bg-slate-50/50 space-y-4 opacity-60 grayscale cursor-not-allowed group transition-all">
              <div className="h-10 w-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-400">
                <Server className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-1">
                  API & Webhooks
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Configure external webhooks and monitor API health status.
                </p>
              </div>
              <span className="inline-flex text-[10px] font-black bg-slate-900 text-white px-2 py-0.5 rounded uppercase tracking-tighter">
                Coming Soon
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
