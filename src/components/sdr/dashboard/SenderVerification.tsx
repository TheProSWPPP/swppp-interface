import {useEffect, useState} from 'react';
import {sdrApi} from '../../../lib/sdrApi';
import {senderVerificationIssues, type SenderVerificationAccount} from './senderVerificationStatus';

export default function SenderVerification() {
  const [result, setResult] = useState<{accounts: SenderVerificationAccount[]; request: number} | null>(null);
  const [errorRequest, setErrorRequest] = useState<number | null>(null);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    let active = true;
    sdrApi.getSenderVerification().then(data => {
      if (active) setResult({accounts: data.accounts, request});
    }).catch(() => { if (active) setErrorRequest(request); });
    return () => { active = false; };
  }, [request]);
  const loading = result?.request !== request && errorRequest !== request;
  const accounts = result?.request === request ? result.accounts : [];
  const issues = senderVerificationIssues(accounts);
  const unknown = errorRequest === request || !accounts.length;
  return <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="Gmail sender verification">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-slate-900">Gmail sender settings</h2>
      <button className="min-h-11 text-sm text-brand-700 underline disabled:opacity-50" disabled={loading} onClick={() => setRequest(value => value + 1)}>Check again</button>
    </div>
    {loading ? <p role="status" className="text-sm text-slate-500">Checking Gmail sender settings…</p>
      : unknown ? <p className="text-sm text-amber-800">Sender settings could not be verified. Check again.</p>
      : issues.length ? <div className="text-sm text-amber-900">
        <p>Sender settings need attention for {issues.length} of {accounts.length} accounts.</p>
        <p className="mt-1 text-slate-600">This check is separate from reading inboxes. It verifies the sender settings Gmail uses.</p>
        <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 font-medium">See affected accounts</summary>
          <ul className="space-y-2">{issues.map(issue => <li key={issue.mailbox}><strong className="break-all">{issue.mailbox}</strong><p>{issue.reconnect ? 'Open Inbox, choose By mailbox and select this account. Use Reconnect to renew Gmail access, then check again.' : 'Sender settings could not be read. Check the account connection.'}</p></li>)}</ul>
        </details>
      </div> : <p className="text-sm text-slate-600">Gmail sender settings were read for all {accounts.length} accounts. Check a sent email to confirm the name recipients see. This does not confirm email delivery.</p>}
  </section>;
}
