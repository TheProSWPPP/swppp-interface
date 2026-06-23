import { useState } from "react";
import { Building2, Mail } from "lucide-react";
import OperatorWorkspace from "./OperatorWorkspace";
import MsgpCopyView from "./MsgpCopyView";

type PermitSub = "leads" | "email";

export default function PermitsTab({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [sub, setSub] = useState<PermitSub>("leads");

  const btn = (v: PermitSub, label: string, icon: React.ReactNode) => (
    <button onClick={() => setSub(v)}
      className={"flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-lg " +
        (sub === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700")}>
      {icon}{label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
        {btn("leads", "Leads", <Building2 className="h-4 w-4" />)}
        {btn("email", "Email Copy", <Mail className="h-4 w-4" />)}
      </div>
      {sub === "leads" ? <OperatorWorkspace pushToast={pushToast} /> : <MsgpCopyView pushToast={pushToast} />}
    </div>
  );
}
