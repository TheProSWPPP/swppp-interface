// Team tab — the admin surface for onboarding a teammate end to end.
//
// Before this existed the only way to add a person was to edit the hardcoded
// 4-person array in scripts/seed-sdr.mjs and re-run it from a terminal with
// DATABASE_URL + APOLLO_API_KEY set. owner_user_id, pipedrive_sender_id and
// permit_daily_cap had no writer anywhere, so a new mailbox silently filed its
// replies under Derek in Pipedrive.
//
// Order enforced by the UI, because it's the order that actually works:
//   1. create the user            2. create their mailbox INACTIVE
//   3. Connect Gmail (consent)    4. set routing, then flip Sending on
// permit_enabled deliberately stays on the Permits tab — one switch, one place.

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle, Check, Copy, KeyRound, Mail, Plus, RefreshCw, ShieldCheck, Trash2, UserPlus, X,
} from "lucide-react";
import { sdrApi, type SdrRole, type SdrTeamUser, type SdrTeamMailboxSummary } from "../../lib/sdrApi";
import { cn } from "../../utils";

type Toast = (kind: "success" | "error", msg: string) => void;

export default function TeamView({ pushToast }: { pushToast: Toast }) {
  const [users, setUsers] = useState<SdrTeamUser[] | null>(null);
  const [requirePassword, setRequirePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewUser, setShowNewUser] = useState(false);
  const [mailboxFor, setMailboxFor] = useState<SdrTeamUser | null>(null);
  const [secret, setSecret] = useState<{ username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await sdrApi.listTeamUsers();
      setUsers(d.users);
      setRequirePassword(d.require_password);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setPassword(u: SdrTeamUser) {
    const pw = window.prompt(
      `Set a password for ${u.display_name || u.username}.\n\nLeave blank to generate a random one.\nMinimum 8 characters.`,
      "",
    );
    if (pw === null) return; // cancelled
    if (pw && pw.length < 8) { pushToast("error", "Password must be at least 8 characters"); return; }
    setBusy(true);
    try {
      const r = pw
        ? await sdrApi.updateTeamUser(u.id, { password: pw })
        : await sdrApi.updateTeamUser(u.id, { generate_password: true });
      if (r.generated_password) setSecret({ username: u.username, password: r.generated_password });
      else pushToast("success", `Password set for ${u.username}`);
      await load();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: SdrTeamUser) {
    setBusy(true);
    try {
      await sdrApi.updateTeamUser(u.id, { active: !u.active });
      pushToast("success", `${u.username} ${u.active ? "deactivated" : "activated"}`);
      await load();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(u: SdrTeamUser) {
    if (!window.confirm(`Delete "${u.username}"? This only works for a row that has never been used — deactivate real people instead.`)) return;
    setBusy(true);
    try {
      await sdrApi.deleteTeamUser(u.id);
      pushToast("success", `${u.username} removed`);
      await load();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  }

  const noPasswordCount = (users || []).filter((u) => u.active && !u.has_password).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Team</h3>
          <p className="mt-0.5 text-xs text-slate-500 max-w-2xl">
            Add a teammate, give them a mailbox with sending switched off, connect their inbox, then turn them on.
            Permit sending stays on the Permits tab.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setShowNewUser(true)}
            className="rounded-xl bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 flex items-center gap-2"
          >
            <UserPlus className="h-4 w-4" /> Add teammate
          </button>
        </div>
      </div>

      <div
        className={cn(
          "rounded-xl border px-4 py-3 text-sm flex items-start gap-2",
          requirePassword ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-600",
        )}
      >
        <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" />
        {requirePassword ? (
          <span>
            <strong>Password login is ON.</strong> Everyone signs in with a password.
            {noPasswordCount > 0 && ` ${noPasswordCount} active user(s) have no password set and cannot sign in — set one now.`}
          </span>
        ) : (
          <span>
            Password login is <strong>off</strong> (<code className="text-xs">REQUIRE_PASSWORD</code> unset). Anyone who
            gets past the dashboard wall can pick any name. Set a password for every active person here first, then have
            Ivan set <code className="text-xs">REQUIRE_PASSWORD=1</code> in Railway.
          </span>
        )}
      </div>

      {secret && (
        <PasswordReveal secret={secret} onClose={() => setSecret(null)} />
      )}

      {!users && <div className="text-sm text-slate-400">Loading team…</div>}

      {users && (
        <div className="space-y-3">
          {users.map((u) => (
            <UserCard
              key={u.id}
              user={u}
              busy={busy}
              onSetPassword={() => setPassword(u)}
              onToggleActive={() => toggleActive(u)}
              onAddMailbox={() => setMailboxFor(u)}
              onDelete={() => removeUser(u)}
              onChanged={load}
              pushToast={pushToast}
            />
          ))}
        </div>
      )}

      {showNewUser && (
        <NewUserModal
          onClose={() => setShowNewUser(false)}
          onCreated={async (created, password) => {
            setShowNewUser(false);
            if (password) setSecret({ username: created.username, password });
            await load();
          }}
          pushToast={pushToast}
        />
      )}

      {mailboxFor && (
        <NewMailboxModal
          user={mailboxFor}
          onClose={() => setMailboxFor(null)}
          onCreated={async () => { setMailboxFor(null); await load(); }}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}

function PasswordReveal({ secret, onClose }: { secret: { username: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-emerald-900 flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Password for {secret.username}
          </div>
          <p className="mt-1 text-xs text-emerald-700">
            Shown once. Copy it and hand it over securely — it is stored only as a bcrypt hash and cannot be read back.
          </p>
          <code className="mt-2 inline-block rounded-lg bg-white px-3 py-1.5 font-mono text-sm text-slate-900 border border-emerald-200">
            {secret.password}
          </code>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { navigator.clipboard?.writeText(secret.password); setCopied(true); }}
            className="rounded-lg border border-emerald-200 bg-white p-2 text-emerald-700 hover:bg-emerald-100"
            title="Copy"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
          <button onClick={onClose} className="rounded-lg p-2 text-emerald-700 hover:bg-emerald-100" title="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function UserCard({
  user, busy, onSetPassword, onToggleActive, onAddMailbox, onDelete, onChanged, pushToast,
}: {
  user: SdrTeamUser;
  busy: boolean;
  onSetPassword: () => void;
  onToggleActive: () => void;
  onAddMailbox: () => void;
  onDelete: () => void;
  onChanged: () => Promise<void>;
  pushToast: Toast;
}) {
  const mailboxes = user.mailboxes || [];
  return (
    <div className={cn("rounded-2xl border bg-white p-4", user.active ? "border-slate-200" : "border-slate-200 bg-slate-50")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{user.display_name || user.username}</span>
            {user.role === "admin" && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700">admin</span>
            )}
            {!user.active && (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">inactive</span>
            )}
            {!user.has_password && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">no password</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {user.username} · {user.email}
            {user.last_login_at && ` · last seen ${new Date(user.last_login_at).toLocaleDateString()}`}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            onClick={onSetPassword}
            disabled={busy}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
          >
            <KeyRound className="h-3.5 w-3.5" /> Set password
          </button>
          <button
            onClick={onToggleActive}
            disabled={busy}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {user.active ? "Deactivate" : "Activate"}
          </button>
          {!user.last_login_at && mailboxes.length === 0 && (
            <button
              onClick={onDelete}
              disabled={busy}
              className="rounded-lg border border-rose-200 px-2 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              title="Delete this never-used row"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 border-t border-slate-100 pt-3">
        {mailboxes.length === 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">No mailbox linked — they can log in but cannot send or see an inbox.</span>
            <button
              onClick={onAddMailbox}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Add mailbox
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {mailboxes.map((m) => (
              <MailboxRow key={m.id} mailbox={m} onChanged={onChanged} pushToast={pushToast} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MailboxRow({
  mailbox, onChanged, pushToast,
}: { mailbox: SdrTeamMailboxSummary; onChanged: () => Promise<void>; pushToast: Toast }) {
  const [senderId, setSenderId] = useState(mailbox.pipedrive_sender_id?.toString() ?? "");
  const [cap, setCap] = useState(mailbox.permit_daily_cap?.toString() ?? "");
  const [saving, setSaving] = useState(false);

  const dirty =
    senderId !== (mailbox.pipedrive_sender_id?.toString() ?? "") ||
    cap !== (mailbox.permit_daily_cap?.toString() ?? "");

  async function save() {
    setSaving(true);
    try {
      await sdrApi.updateMailboxRouting(mailbox.id, {
        pipedrive_sender_id: senderId === "" ? null : Number(senderId),
        permit_daily_cap: cap === "" ? null : Number(cap),
      });
      pushToast("success", `${mailbox.email} routing saved`);
      await onChanged();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleSending() {
    setSaving(true);
    try {
      await sdrApi.updateMailboxRouting(mailbox.id, { active: !mailbox.active });
      pushToast("success", `${mailbox.email} sending ${mailbox.active ? "off" : "on"}`);
      await onChanged();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function connectGmail() {
    try {
      const { url } = await sdrApi.startInboxOAuth(mailbox.email);
      window.location.href = url;
    } catch (e) {
      pushToast("error", (e as Error).message);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-slate-800">
          <Mail className="h-4 w-4 text-slate-400" />
          <span className="font-medium">{mailbox.email}</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-semibold",
              mailbox.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600",
            )}
          >
            {mailbox.active ? "sending" : "sending off"}
          </span>
          {mailbox.permit_enabled && (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">permits</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={connectGmail}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            Connect Gmail
          </button>
          <button
            onClick={toggleSending}
            disabled={saving}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            {mailbox.active ? "Turn sending off" : "Turn sending on"}
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">
          <span className="block mb-1">Pipedrive sender id</span>
          <input
            value={senderId}
            onChange={(e) => setSenderId(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="e.g. 19499202"
            className="w-36 rounded-lg border border-slate-200 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          <span className="block mb-1">Permit daily cap</span>
          <input
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="e.g. 20"
            className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-sm"
          />
        </label>
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {!mailbox.pipedrive_sender_id && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700">
          <AlertCircle className="h-3.5 w-3.5 mt-px flex-shrink-0" />
          With no sender id, replies to this mailbox get filed under Derek in Pipedrive.
        </p>
      )}
    </div>
  );
}

function NewUserModal({
  onClose, onCreated, pushToast,
}: {
  onClose: () => void;
  onCreated: (u: SdrTeamUser, password?: string) => Promise<void>;
  pushToast: Toast;
}) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<SdrRole>("sdr");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const r = await sdrApi.createTeamUser({
        username,
        email,
        display_name: displayName || undefined,
        role,
        active: true,
        password: password || undefined,
      });
      await onCreated(r.user, r.generated_password);
      if (!r.generated_password) pushToast("success", `${username} created`);
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add teammate" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Username" hint="Lowercase, what they click on the sign-in screen">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))}
            placeholder="cameron"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field
          label="Email"
          hint="The part before the @ MUST match their mailbox (cw@proswppp.com ↔ cw@proswppp.co) or their inbox stays invisible to them"
        >
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value.toLowerCase())}
            placeholder="cw@proswppp.com"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Cameron Williams"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Role">
          <div className="flex gap-2">
            {(["sdr", "admin"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm font-medium",
                  role === r ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Password" hint="Leave blank to generate one — it's shown once, then only the bcrypt hash is kept">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="(auto-generate)"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={saving || !username || !email}
          className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

function NewMailboxModal({
  user, onClose, onCreated, pushToast,
}: {
  user: SdrTeamUser;
  onClose: () => void;
  onCreated: () => Promise<void>;
  pushToast: Toast;
}) {
  const local = user.email.split("@")[0];
  const [email, setEmail] = useState(`${local}@proswppp.co`);
  const [senderId, setSenderId] = useState("");
  const [cap, setCap] = useState("20");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      await sdrApi.createTeamMailbox({
        email,
        display_name: user.display_name || undefined,
        owner_user_id: user.id,
        pipedrive_sender_id: senderId ? Number(senderId) : null,
        permit_daily_cap: cap ? Number(cap) : null,
        active: false,        // always born switched off
        permit_enabled: false,
      });
      pushToast("success", `${email} created with sending off`);
      await onCreated();
    } catch (e) {
      pushToast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Add a mailbox for ${user.display_name || user.username}`} onClose={onClose}>
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 mb-3">
        Created with <strong>sending off</strong> and <strong>permits off</strong>. Connect Gmail first, then turn sending
        on from the row below. The mailbox must already exist in Google Workspace.
      </div>
      <div className="space-y-3">
        <Field label="Mailbox address" hint={`Must start with "${local}" to stay visible to ${user.email}`}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value.toLowerCase())}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Pipedrive sender id" hint="Their Pipedrive user id — without it, their replies file under Derek">
          <input
            value={senderId}
            onChange={(e) => setSenderId(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="e.g. 26444374"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Permit daily cap" hint="Matches the other mailboxes at 20">
          <input
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={saving || !email}
          className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create (sending off)"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-slate-700">{label}</div>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}
