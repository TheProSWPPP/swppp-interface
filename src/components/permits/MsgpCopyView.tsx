import { useEffect, useMemo, useState } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import { getMsgpTemplate, putMsgpTemplate, createMsgpSequence, type MsgpTemplate } from "../../lib/permitApi";

const MERGE_TAGS = [
  { label: "First name", token: "{{first_name}}" },
  { label: "Operator",   token: "{{operator}}" },
  { label: "Permit #",   token: "{{permit}}" },
  { label: "Expiry",     token: "{{expires}}" },
] as const;

export default function MsgpCopyView({ pushToast }: { pushToast?: (m: string, k?: "success" | "error") => void }) {
  const [tpl, setTpl] = useState<MsgpTemplate | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSource, setShowSource] = useState(false);

  const modules = useMemo(() => ({
    toolbar: [
      [{ header: [1, 2, false] }],
      ["bold", "italic", "underline"],
      ["link"],
      [{ list: "ordered" }, { list: "bullet" }],
      ["clean"],
    ],
  }), []);

  useEffect(() => {
    getMsgpTemplate()
      .then(({ template }) => {
        setTpl(template);
        setSubject(template.subject);
        setBody(template.body_html);
      })
      .catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const { template } = await putMsgpTemplate(subject, body);
      setTpl(template);
      pushToast?.("Copy saved", "success");
    } catch {
      pushToast?.("Failed to save copy", "error");
    } finally {
      setBusy(false);
    }
  };

  const makeSeq = async () => {
    setBusy(true);
    try {
      const { apollo_sequence_id } = await createMsgpSequence();
      setTpl((t) => (t ? { ...t, apollo_sequence_id } : t));
      pushToast?.("Test sequence created", "success");
    } catch {
      pushToast?.("Failed to create sequence", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Sending OFF banner */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Sending is OFF. This screen only stores the email copy and (optionally) creates an inactive test sequence — nothing is emailed.
      </div>

      {/* Subject */}
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
      </div>

      {/* Merge-tag inserter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Insert token:</span>
        {MERGE_TAGS.map(({ label, token }) => (
          <button
            key={token}
            type="button"
            disabled={busy}
            onClick={() => setBody((b) => b + " " + token)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-50"
          >
            {label}
          </button>
        ))}
        <span className="text-xs text-slate-400 italic">Tokens like {"{{first_name}}"} are filled per recipient at send time.</span>
      </div>

      {/* Body editor + source toggle */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Body</label>
          <button
            type="button"
            onClick={() => setShowSource((s) => !s)}
            className={
              "flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors " +
              (showSource
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700")
            }
          >
            {"</>"} HTML source
          </button>
        </div>

        {showSource ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            rows={18}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
        ) : (
          <ReactQuill
            theme="snow"
            value={body}
            onChange={setBody}
            readOnly={busy}
            modules={modules}
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save copy
        </button>
        <button
          onClick={makeSeq}
          disabled={busy}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
        >
          Create test sequence
        </button>
        {tpl?.apollo_sequence_id && (
          <span className="text-xs text-slate-500">
            Apollo sequence: <code>{tpl.apollo_sequence_id}</code>
          </span>
        )}
      </div>
    </div>
  );
}
