import { useEffect, useState } from "react";
import { getMsgpTemplate, putMsgpTemplate, createMsgpSequence, type MsgpTemplate } from "../../lib/permitApi";

export default function MsgpCopyView({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [tpl, setTpl] = useState<MsgpTemplate | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMsgpTemplate().then(({ template }) => { setTpl(template); setSubject(template.subject); setBody(template.body_html); }).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    try { const { template } = await putMsgpTemplate(subject, body); setTpl(template); pushToast?.("Copy saved", "success"); }
    catch { pushToast?.("Failed to save copy", "error"); }
    finally { setBusy(false); }
  };
  const makeSeq = async () => {
    setBusy(true);
    try { const { apollo_sequence_id } = await createMsgpSequence(); setTpl((t) => t ? { ...t, apollo_sequence_id } : t); pushToast?.("Test sequence created", "success"); }
    catch { pushToast?.("Failed to create sequence", "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Sending is OFF. This screen only stores the email copy and (optionally) creates an inactive test sequence — nothing is emailed.
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Body (HTML)</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} rows={16}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preview</label>
          {/* Admin-only preview of the admin's own copy (Basic-auth tool); not user-generated content. */}
          <div className="mt-1 h-[22rem] overflow-auto rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm" dangerouslySetInnerHTML={{ __html: body }} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Save copy</button>
        <button onClick={makeSeq} disabled={busy} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Create test sequence</button>
        {tpl?.apollo_sequence_id && <span className="text-xs text-slate-500">Apollo sequence: <code>{tpl.apollo_sequence_id}</code></span>}
      </div>
    </div>
  );
}
