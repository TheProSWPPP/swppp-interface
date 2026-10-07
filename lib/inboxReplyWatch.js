// Inbox reply watch — reads every connected Gmail mailbox and does two things on a new
// lead reply:
//   1. FORWARD it to the rep's real @proswppp.com inbox (dc/jg/mh/th), with a link to the
//      interface, so reps catch replies in their normal inbox.
//   2. Create a Pipedrive follow-up activity + note, but only if nothing already flagged the
//      reply (Apollo's poll, or an earlier pass) in the last 48h — so a reply becomes exactly
//      one task. Apollo's own handler shares the same 48h guard, so whichever sees it first
//      wins and there's no duplicate.
// Both are deduped on the Gmail message id (the reply-log claim), so a message is processed
// once. This also catches replies Apollo can't see at all (permit channel, off-contact).

import * as gmailInbox from "./gmailInbox.js";
import * as pipedriveClient from "./pipedriveClient.js";
import * as apolloClient from "./apolloClient.js";
import { stopOwnedEnrollment } from "./sdrProviderOperations.js";
import { enqueueReplyActions, replyActionsEnabled } from './sdrReplyActions.js';
import { safeErrorCategory } from './sdrJobRuns.js';
import { observeInbound } from './sdrReportingIngest.js';
import { resolveReplyProject, checkReplyThread, observeReplyThread } from './sdrReplyContext.js';
import { acquireLeadLock } from './sdrAccess.js';

const DEREK_PD_USER_ID = 19499202; // fallback assignee when a rep has no Pipedrive seat mapped
export const SEQUENCE_STARTED_FIELD = "48c4bb758e8642d6372c7fff9df3c0ea716170f1"; // PD custom field, mirrors server.js
// Model for the second-stage reply-intent filter. Pinned to an explicit version (not a
// -latest alias) so a live gate can't silently shift behavior; override via env to bump.
const REPLY_INTENT_MODEL = process.env.REPLY_INTENT_MODEL || "gemini-3.6-flash";

export async function ensureReplyLogTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_inbox_reply_log (
      gmail_message_id   TEXT PRIMARY KEY,
      thread_id          TEXT,
      mailbox_email      TEXT,
      from_addr          TEXT,
      pipedrive_lead_id  TEXT,
      activity_id        TEXT,
      forwarded_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE sdr_inbox_reply_log ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ`);
  // intent = the re-engagement tag for a real reply the filter judged not worth a rep's time
  // (in_house / not_interested / unsubscribe / no_action). Kept in Postgres, NOT a Pipedrive
  // custom field, so we can query dead/soft replies later without cluttering the CRM schema.
  await pool.query(`ALTER TABLE sdr_inbox_reply_log ADD COLUMN IF NOT EXISTS intent TEXT`);
  await pool.query(`ALTER TABLE sdr_inbox_reply_log ADD COLUMN IF NOT EXISTS intent_reason TEXT`);
}

// Don't forward obvious non-prospect mail (our own E2E test addresses) to a rep's inbox.
function isTestContact(email, leadTitle) {
  return /ivan\.manfredi2001|prodtest|@example\./i.test(email || "") || /^e2e\b/i.test(leadTitle || "");
}

// Classify inbound mail that is NOT a genuine prospect reply. NDRs and auto-responders often
// quote the original recipient, so they'd match a lead by participant and (wrongly) get
// forwarded + spawn a follow-up task. Returns:
//   "bounce" → a non-delivery report / blocked message → record it as a bounce, stop sequence
//   "auto"   → out-of-office / vacation auto-reply → silently ignore
//   null     → a real reply → forward + task as normal
export function classifyInbound(from, subject, snippet) {
  const f = String(from || "").toLowerCase();
  const s = `${subject || ""} ${snippet || ""}`.toLowerCase();
  const bounceFrom = /mailer-daemon|postmaster@|mail delivery (subsystem|system)/i.test(f);
  const bounceText =
    /delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed|delivery incomplete|failure notice|message (was )?not delivered|address (not found|couldn'?t be found)|recipient.*not found|could ?n'?t be delivered|wasn'?t delivered|message (blocked|rejected)|550 5\./i.test(
      s,
    );
  if (bounceFrom || bounceText) return "bounce";
  // Out-of-office / vacation / leave auto-responders. Kept high-precision: each alternative is a
  // phrase that appears in auto-replies but not in a genuine "yes let's talk" reply. Note the
  // hyphen/space tolerance — "out-of-office" is as common as "out of office", and leave notices
  // (maternity/medical/annual) are the other big class the old pattern missed.
  const autoText =
    /automatic reply|auto[- ]?reply|out[-\s]?of[-\s]?(the[-\s]?)?office|on (maternity|paternity|parental|medical|sick|annual|extended|family|bereavement) leave|\bon leave\b|(currently|presently) (out of|away|on leave|unavailable)|away (from (my|the) (desk|office)|until|on vacation)|on (vacation|holiday|pto)\b|(i will|i'll|will) (be back|return)( to (the )?office)? (on|in|by)|return(ing)? to (the )?office on|limited access to (my )?(e-?mail|inbox)/i;
  if (autoText.test(s)) return "auto";
  return null;
}

// Second-stage filter: classifyInbound only strips bounces/auto-replies, but a genuine human
// reply still isn't necessarily worth a rep's time (e.g. "we do it in-house", "remove me").
// A light Gemini call judges intent. Returns { worth, label, reason }.
//   worth=true  → interested / question / soft not-now → forward + task as normal
//   worth=false → hard no / in-house / unsubscribe / bare ack → quiet note, no ping
// Biased to worth=true: any API failure, empty body, or unparseable response forwards, so a
// real buyer is never silently hidden by a classifier hiccup.
export async function classifyReplyIntent({ from, subject, body } = {}) {
  const text = `${subject || ""}\n${body || ""}`.trim().slice(0, 4000);
  if (!process.env.GEMINI_API_KEY || !text) return { worth: true, label: "unknown", reason: "no-classifier" };
  const prompt =
    `You triage inbound replies to a B2B cold sales email (stormwater/SWPPP compliance services). ` +
    `Decide if this reply is worth a human sales rep replying to.\n` +
    `WORTH (worth=true): interested, asking a question, requesting pricing/a call/more info, or a soft ` +
    `"not right now / maybe later" that could re-engage.\n` +
    `NOT WORTH (worth=false): a clear hard no, "we handle it in-house", "we already have a vendor" with no ` +
    `openness, remove/unsubscribe requests, or a pure acknowledgement needing no action ("got it, thanks").\n` +
    `Bias: if you are unsure, choose worth=true. Never hide a possible buyer.\n\n` +
    `Reply FROM: ${from || "unknown"}\nReply TEXT:\n"""${text}"""\n\n` +
    `Respond with ONLY minified JSON: {"worth": true|false, "label": ` +
    `"interested|question|nurture|in_house|not_interested|unsubscribe|no_action", "reason": "<=12 words"}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${REPLY_INTENT_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      },
    );
    if (!r.ok) return { worth: true, label: "unknown", reason: `api-${r.status}` };
    const d = await r.json().catch(() => ({}));
    const raw = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return {
      worth: parsed.worth !== false, // default worth=true unless explicitly false
      label: String(parsed.label || "unknown").slice(0, 40),
      reason: String(parsed.reason || "").slice(0, 120),
    };
  } catch (e) {
    return { worth: true, label: "unknown", reason: `err:${String(e.message || "").slice(0, 40)}` };
  }
}

// Pull email addresses out of NDR text (subject + snippet + body), dropping our own mailboxes
// and the daemon senders, so the remaining address is the prospect we failed to reach.
function extractFailedRecipient(text) {
  const found = String(text || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
  for (const e of found) {
    if (/@proswppp\.(co|com)$/.test(e)) continue; // our sending mailboxes
    if (/mailer-daemon|postmaster|googlemail|google\.com|apollo\.io/.test(e)) continue; // infra
    return e;
  }
  return null;
}

const FORWARD_MAX_AGE_MS = 24 * 60 * 60 * 1000; // only forward genuinely fresh replies

export function createReplyActionClients({ pool, getToken, appBase, gmail = gmailInbox, pipedrive = pipedriveClient, apollo = apolloClient }) {
  const base = appBase || process.env.PUBLIC_BASE_URL || 'https://swppp-interface-production.up.railway.app';
  const marker = action => `[SDR reply action ${action.id}]`;
  const messageId = action => `<sdr-action-${action.id}@proswppp.co>`;
  const configured = () => Object.assign(new Error('reply_action_configuration'),{permanent:true,definiteFailure:true});
  const requestStop = async action => {
    await verifyProject(action);
    const p=action.payload;
    return stopOwnedEnrollment({pool,apollo,actionId:`reply-stop:${action.id || p.sendId}`,expected:{
      contactId:p.contactId,campaignId:p.sequenceId,sendId:p.sendId,leadId:p.leadId,
      membershipId:p.membershipId || null,addedAt:p.addedAt || null,
    }});
  };
  const stopState = async action => {
    if (!action.payload?.sendId || !action.payload?.leadId) return {state:'unknown'};
    const result=await requestStop(action);
    return result.status==='confirmed' && result.receipt?.id ? {state:'completed',receipt:result.receipt} : {state:'unknown'};
  };
  const route = async (action,kind) => {
    const p = action.payload;
    const r = (await pool.query('SELECT forward_to,pipedrive_user_id FROM sdr_reply_routes WHERE mailbox_email=$1 AND active AND verified_at IS NOT NULL',[p.mailbox])).rows[0];
    if (!r || (kind === 'forward' ? r.forward_to !== p.forwardTo : String(r.pipedrive_user_id) !== String(p.userId))) throw configured();
  };
  const freshThread = async action => {
    const p=action.payload;
    if (!p.mailbox || !p.threadId || !p.sourceMessageId) throw Object.assign(new Error('reply_context_unavailable'),{permanent:true,definiteFailure:true,replyContextReason:'reply_context_unavailable'});
    let token,thread;
    try { token=await getToken(p.mailbox);thread=await gmail.getThread(token,p.threadId); }
    catch { throw Object.assign(new Error('reply_context_unavailable'),{permanent:true,definiteFailure:true,replyContextReason:'reply_context_unavailable'}); }
    const original=(thread?.messages || []).find(m=>m.id===p.sourceMessageId);
    if(!original) throw Object.assign(new Error('reply_context_unavailable'),{permanent:true,definiteFailure:true,replyContextReason:'reply_context_unavailable'});
    const project=await resolveReplyProject(pool,{mailbox:p.mailbox,thread,message:original});
    return {token,thread,original,project};
  };
  const verifyProject = async action => {
    const fresh=await freshThread(action);
    if(!action.payload.leadId || fresh.project.status!=='verified' || fresh.project.leadId!==action.payload.leadId)
      throw Object.assign(new Error('project_context_unverified'),{permanent:true,definiteFailure:true,replyContextReason:'project_context_unverified'});
    return fresh;
  };
  const freshReply = async (action,requireProject=false) => {
    const fresh=await (requireProject ? verifyProject(action) : freshThread(action));
    const context=await checkReplyThread({pool,mailbox:action.payload.mailbox,thread:fresh.thread,sourceMessageId:action.payload.sourceMessageId});
    if(context.state!=='clear' && context.state!=='staff_replied') throw Object.assign(new Error(context.state),{permanent:true,definiteFailure:true,replyContextReason:context.state==='unavailable' ? 'reply_context_unavailable' : context.state});
    return {...fresh,...context};
  };
  const clearLeadFlag = async (action,reconcileOnly=false) => {
    if(!reconcileOnly) await verifyProject(action);
    const p=action.payload;
    if (!p.leadId || !Array.isArray(p.stopTargets) || !p.stopTargets.length || !Array.isArray(p.stopSends) || !p.stopSends.length) throw configured();
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await acquireLeadLock(client,p.leadId);
      const deps=(await client.query(`SELECT target_key,status,external_id,receipt_at FROM sdr_reply_actions
        WHERE provider_message_id=$1 AND kind='stop_sequence' AND target_key=ANY($2::text[])`,[action.provider_message_id,p.stopTargets])).rows;
      if (deps.length!==p.stopTargets.length || deps.some(d=>d.status!=='completed' || !d.external_id || !d.receipt_at)) throw Object.assign(new Error('dependencies_pending'),{deferred:true});
      const sends=(await client.query('SELECT id,pipedrive_lead_id,apollo_sequence_id,apollo_contact_id FROM sdr_sends WHERE id::text=ANY($1::text[])',[p.stopSends.map(s=>String(s.sendId))])).rows;
      if (sends.length!==p.stopSends.length || sends.some(s=>s.pipedrive_lead_id!==p.leadId || !p.stopSends.some(t=>String(t.sendId)===String(s.id) && t.sequenceId===s.apollo_sequence_id && t.contactId===s.apollo_contact_id))) throw configured();
      const active=(await client.query(`SELECT 1 FROM sdr_sends s WHERE status IN ('enrolled','sent') AND (
        pipedrive_lead_id=$1 OR EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS t("sequenceId" text,"contactId" text)
          WHERE t."sequenceId"=s.apollo_sequence_id AND t."contactId"=s.apollo_contact_id)) LIMIT 1`,[p.leadId,JSON.stringify(p.stopSends)])).rowCount;
      if (active) throw configured();
      const lead=await pipedrive.getLead(p.leadId);
      if (String(lead?.id)!==String(p.leadId) || lead?.is_archived!==false || !Object.hasOwn(lead,SEQUENCE_STARTED_FIELD)) throw configured();
      let clear=lead[SEQUENCE_STARTED_FIELD]===null || lead[SEQUENCE_STARTED_FIELD]==='';
      if (!clear && !reconcileOnly) {
        if (p.expectedFlag==null || String(lead[SEQUENCE_STARTED_FIELD])!==String(p.expectedFlag)) throw configured();
        // A read followed by PATCH cannot protect a newer external marker.
        throw configured();
      }
      await client.query('COMMIT');
      return clear ? {state:'completed',receipt:{id:lead.id}} : {state:'unknown'};
    } catch(error) { await client.query('ROLLBACK').catch(()=>{});throw error; }
    finally {client.release();}
  };
  return {
    clear_sequence_flag:{execute:async action=>(await clearLeadFlag(action)).receipt,reconcile:action=>clearLeadFlag(action,true)},
    stop_sequence: { reconcile:stopState,execute: async action => {
      const result=await requestStop(action);
      if (result.status==='confirmed' && result.receipt?.id) return result.receipt;
      throw Object.assign(new Error(result.reason || 'stop_requires_review'),{uncertain:true,permanent:result.status==='superseded',operationId:result.operationId});
    } },
    forward: {
      execute: async action => {
        await route(action,'forward');
        const p = action.payload;
        const context=await freshReply(action);
        if(context.state==='staff_replied') return {skipped:true,reason:'staff_replied'};
        const {token,original}=context;
        const leadId=context.project.status==='verified' && context.project.leadId===p.leadId ? p.leadId : null;
        const link=leadId ? `${base}/#/sdr?inboxLead=${encodeURIComponent(leadId)}` : `${base}/#/sdr`;
        const note = `New ${p.intent} reply.${leadId ? '' : ' Project match needs review.'} Open in interface: ${link}\nSource thread: ${p.threadId}\n${marker(action)}`;
        return gmail.sendMail(token,{from:p.mailbox,to:p.forwardTo,subject:`Reply (${p.intent}): ${original.subject || 'Prospect reply'}`,
          bodyText:gmail.buildForwardText(note,original),bodyHtml:gmail.buildForwardHtml(note,original),messageId:messageId(action)});
      },
      reconcile: async action => {
        const p=action.payload;
        const token = await getToken(p.mailbox);
        const original=(await gmail.getThread(token,p.threadId)).messages.find(m=>m.id===p.sourceMessageId);
        if(!original) return {state:'unknown'};
        const expectedSubject=`Reply (${p.intent}): ${original.subject || 'Prospect reply'}`;
        const timestamp=value=>value && Number.isFinite(+new Date(value)) ? +new Date(value) : null;
        const createdAt=timestamp(action.created_at),inboundAt=timestamp(original.receivedAt);
        if(createdAt===null || inboundAt===null) return {state:'unknown'};
        const normalize=value=>String(value || '').replace(/\r\n?/g,'\n').split('\n').map(line=>line.trimEnd()).join('\n').trim();
        const expectedNotes=[`New ${p.intent} reply. Project match needs review. Open in interface: ${base}/#/sdr\nSource thread: ${p.threadId}\n${marker(action)}`];
        if(p.leadId) expectedNotes.push(`New ${p.intent} reply. Open in interface: ${base}/#/sdr?inboxLead=${encodeURIComponent(p.leadId)}\nSource thread: ${p.threadId}\n${marker(action)}`);
        const addresses=value=>(String(value || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
        const found=[];
        let complete=true;
        for(const query of [`in:sent rfc822msgid:${messageId(action)}`,`in:sent "${marker(action)}"`]) {
          const page=await gmail.listThreadPage(token,{query,maxResults:25});
          if(!Array.isArray(page.threads) || page.nextPageToken) complete=false;
          for(const thread of page.threads || []) {
            const full=await gmail.getThread(token,thread.id);
            for(const msg of full.messages || []) {
              const body=String(msg.body || '').replace(/\r\n?/g,'\n');
              const delimiter='\n\n---------- Forwarded message ----------\n';
              const boundary=body.indexOf(delimiter);
              const note=boundary>=0 ? normalize(body.slice(0,boundary)) : null;
              const sentAt=timestamp(msg.receivedAt);
              if(msg.id && msg.lastOutbound && sentAt!==null && sentAt>=createdAt && sentAt>=inboundAt
                && addresses(msg.from).length===1 && addresses(msg.from)[0]===p.mailbox.toLowerCase()
                && addresses(msg.to).length===1 && addresses(msg.to)[0]===p.forwardTo.toLowerCase()
                && msg.subject===expectedSubject && expectedNotes.some(expected=>normalize(expected)===note)
                && body.slice(boundary+delimiter.length).trim()) found.push(msg.id);
            }
          }
        }
        const receipts=[...new Set(found)];
        if(complete && receipts.length===1) return {state:'completed',receipt:{id:receipts[0]}};
        return {state:'unknown'};
      },
    },
    create_task: {
      execute: async action => {
        await route(action,'create_task');
        const p = action.payload;
        const context=await freshReply(action,true);
        if(context.state==='staff_replied') return {skipped:true,reason:'staff_replied'};
        const receipt = await pipedrive.addActivity({leadId:p.leadId,type:'task',done:false,userId:Number(p.userId),strictAssignee:true,
          subject:`Reply received — follow up ${marker(action)}`,note:`Intent: ${p.intent}. Open in interface: ${base}/#/sdr?inboxLead=${encodeURIComponent(p.leadId)}`});
        const owner = receipt?.user_id ?? receipt?.owner_id;
        if (String(owner) !== String(p.userId)) throw Object.assign(new Error('assignee_receipt_unknown'),{uncertain:true});
        return {id:receipt.id,assigneeId:Number(owner)};
      },
      reconcile: async action => {
        const list = await pipedrive.listActivities(action.payload.leadId,{limit:100});
        const found = list.find(a=>String(a.subject || '').includes(marker(action)));
        const owner = found?.user_id ?? found?.owner_id;
        return found?.id && String(owner) === String(action.payload.userId)
          ? {state:'completed',receipt:{id:found.id,assigneeId:Number(owner)}} : {state:'unknown'};
      },
    },
    create_note: { execute: async action => { await verifyProject(action); return pipedrive.addNote({leadId:action.payload.leadId,
      content:`[Auto] ${action.payload.intent} reply received. Open in interface: ${base}/#/sdr?inboxLead=${encodeURIComponent(action.payload.leadId)}\n${marker(action)}`}); } },
  };
}

export async function pollInboxReplies(pool, { getToken, appBase, featureEnabled = replyActionsEnabled(), ...options }) {
  if (featureEnabled) return collectReliableReplies(pool, { getToken, ...options });
  if (!process.env.PIPEDRIVE_API_TOKEN) return { skipped: "no-pipedrive" };
  await ensureReplyLogTable(pool);
  const base = appBase || process.env.PUBLIC_BASE_URL || "https://swppp-interface-production.up.railway.app";

  const { rows: boxes } = await pool.query(
    `SELECT a.mailbox_email AS email, m.pipedrive_sender_id
       FROM sdr_inbox_accounts a
       JOIN sdr_mailboxes m ON m.email = a.mailbox_email`,
  );

  let scanned = 0;
  let created = 0;
  let forwarded = 0;
  let bounced = 0;
  let skipped = 0;

  for (const box of boxes) {
    let token;
    try {
      token = await getToken(box.email);
    } catch {
      continue; // mailbox not connected / token failure — skip, try the rest
    }
    let threads;
    try {
      threads = await gmailInbox.listThreads(token, { q: "in:inbox newer_than:7d", maxResults: 25 });
    } catch {
      continue;
    }

    for (const t of threads) {
      if (t.lastOutbound) continue; // our message is the latest → nothing waiting on us
      if (!t.lastMessageId) continue;
      const when = Date.parse(t.date || "") || 0;
      scanned++;

      // Anchor dedup on the message id: claim it once, never reprocess.
      const claim = await pool.query(
        `INSERT INTO sdr_inbox_reply_log (gmail_message_id, thread_id, mailbox_email, from_addr)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (gmail_message_id) DO NOTHING
         RETURNING gmail_message_id`,
        [t.lastMessageId, t.id, box.email, String(t.from || "").slice(0, 250)],
      );
      if (!claim.rows.length) continue; // already handled this message

      // Bounces / NDRs / auto-responders are not replies: don't forward, don't make a task.
      const klass = classifyInbound(t.from, t.subject, t.snippet);
      if (klass === "auto") {
        await pool.query(`UPDATE sdr_inbox_reply_log SET from_addr = $1 WHERE gmail_message_id = $2`, [
          `[auto-reply] ${String(t.from || "").slice(0, 230)}`,
          t.lastMessageId,
        ]);
        continue;
      }
      if (klass === "bounce") {
        try {
          const handled = await recordInboxBounce(pool, token, t, box, base);
          if (handled) bounced++;
        } catch (e) {
          console.error("[inbox-reply-watch] bounce record failed:", e.message);
        }
        await pool.query(`UPDATE sdr_inbox_reply_log SET from_addr = $1 WHERE gmail_message_id = $2`, [
          `[bounce] ${String(t.from || "").slice(0, 230)}`,
          t.lastMessageId,
        ]);
        continue;
      }

      const parts = Array.isArray(t.participants) ? t.participants : [];
      if (!parts.length) continue;

      const { rows: leadRows } = await pool.query(
        `SELECT pipedrive_lead_id, lead_title, person_email
           FROM sdr_lead_state WHERE lower(person_email) = ANY($1) LIMIT 1`,
        [parts],
      );
      const lead = leadRows[0];
      if (!lead) continue; // not a known SDR lead (e.g. a permit operator with no Pipedrive lead)
      await pool.query(`UPDATE sdr_inbox_reply_log SET pipedrive_lead_id = $1 WHERE gmail_message_id = $2`, [
        lead.pipedrive_lead_id,
        t.lastMessageId,
      ]);

      // EJECT from the Apollo sequence. Any prospect reply must stop further follow-ups so a
      // rep can take over manually — regardless of sentiment (in-house / unsubscribe / hot
      // lead all stop). The Apollo poll only ejects replies Apollo itself matched to its sent
      // message; this catches the off-thread ones (reply from a different address than the
      // sequenced contact, permit channel) that Apollo never flagged, which otherwise keep
      // sending. Mirrors the bounce path. Idempotent: removing an already-removed contact is a
      // no-op, so it's safe even when the Apollo poll also ejects the same reply.
      let sequenceEjected = false;
      if (process.env.APOLLO_API_KEY) {
        try {
          const { rows: sndRows } = await pool.query(
            `UPDATE sdr_sends SET status = 'replied', last_status_at = NOW(), updated_at = NOW()
              WHERE pipedrive_lead_id = $1 AND status IN ('enrolled','sent')
                AND apollo_contact_id IS NOT NULL AND apollo_sequence_id IS NOT NULL
              RETURNING id, apollo_contact_id, apollo_sequence_id`,
            [lead.pipedrive_lead_id],
          );
          const snd = sndRows[0];
          if (snd) {
            const result=await stopOwnedEnrollment({pool,apollo:apolloClient,actionId:`inbox-reply:${t.lastMessageId}:${snd.id}`,expected:{
              contactId:snd.apollo_contact_id,campaignId:snd.apollo_sequence_id,sendId:snd.id,leadId:lead.pipedrive_lead_id,membershipId:null,addedAt:null,
            }});
            sequenceEjected = result.status==='confirmed';
          }
        } catch (e) {
          console.error("[inbox-reply-watch] Apollo remove-on-reply failed:", e.message);
        }
      }

      const contactEmail = parts.find((p) => p === String(lead.person_email || "").toLowerCase()) || parts[0];

      // Second-stage intent filter. classifyInbound above only strips bounces/auto-replies; a
      // genuine human reply still isn't necessarily worth a rep's time. Fetch the thread once,
      // judge intent, and only forward + task the ones worth replying to. Dead-ends (hard no,
      // in-house, unsubscribe, bare ack) get a quiet note quoting the reply for re-engagement.
      let lastMsg = null;
      try {
        const full = await gmailInbox.getThread(token, t.id);
        const msgs = full.messages || [];
        lastMsg = msgs[msgs.length - 1] || null;
      } catch {
        /* best-effort; classifier falls back to the snippet below */
      }
      const replyText = (lastMsg?.body || t.snippet || "").slice(0, 4000);

      const intent = await classifyReplyIntent({ from: t.from, subject: t.subject, body: replyText });
      if (!intent.worth) {
        // Not worth a rep's time: no forward, no hot-lead task. Store the intent tag in Postgres
        // (re-engagement queryable — deliberately NOT a Pipedrive custom field) and drop a quiet
        // note quoting the reply so the rep can see exactly what was said if they look.
        await pool.query(`UPDATE sdr_inbox_reply_log SET intent = $1, intent_reason = $2 WHERE gmail_message_id = $3`, [
          intent.label,
          intent.reason,
          t.lastMessageId,
        ]);
        try {
          await pipedriveClient.addNote({
            leadId: lead.pipedrive_lead_id,
            content:
              `[Auto] Reply${contactEmail ? ` from ${contactEmail}` : ""} — classified "${intent.label}"` +
              `${intent.reason ? ` (${intent.reason})` : ""}. No rep action needed.` +
              `${sequenceEjected ? " Removed from Apollo sequence — no more follow-ups." : ""}\n\n` +
              `> ${replyText.replace(/\n/g, "\n> ").slice(0, 1500)}`,
          });
        } catch (e) {
          console.error("[inbox-reply-watch] skip-note failed:", e.message);
        }
        skipped++;
        continue; // dead-end reply — stop here, no forward, no task
      }

      // FORWARD the reply to the rep's real @proswppp.com inbox (same local-part as the .co
      // sending mailbox: dc/jg/mh/th), with a link to the interface. Fires for EVERY fresh
      // reply the filter kept, independent of the Pipedrive activity below. Deduped by the
      // message-id claim.
      if (!isTestContact(contactEmail, lead.lead_title) && when && when > Date.now() - FORWARD_MAX_AGE_MS) {
        try {
          const last = lastMsg || {};
          const com = `${String(box.email).split("@")[0]}@proswppp.com`;
          const link = `${base}/#/sdr?inboxLead=${lead.pipedrive_lead_id}`;
          const pdLink = `https://proswpppllc.pipedrive.com/leads/inbox/${lead.pipedrive_lead_id}`;
          const note =
            `New reply on "${lead.lead_title || "a lead"}" from ${contactEmail}.\n` +
            `Intent: ${intent.label}${intent.reason ? ` (${intent.reason})` : ""}\n\n` +
            `Open in SDR interface: ${link}\n` +
            `Open lead in Pipedrive: ${pdLink}`;
          await gmailInbox.sendMail(token, {
            from: box.email,
            to: com,
            // Lead intent up front so a glance at the inbox triages it (interested/question/nurture).
            subject: `Reply (${intent.label}): ${lead.lead_title || contactEmail}`,
            bodyText: gmailInbox.buildForwardText(note, last),
            bodyHtml: gmailInbox.buildForwardHtml(note, last),
          });
          await pool.query(`UPDATE sdr_inbox_reply_log SET forwarded_at = NOW() WHERE gmail_message_id = $1`, [
            t.lastMessageId,
          ]);
          forwarded++;
        } catch (e) {
          console.error("[inbox-reply-watch] forward failed:", e.message);
        }
      }

      // Pipedrive activity — deferred to whatever already flagged this lead's reply (Apollo
      // or an earlier pass) so a reply becomes exactly one task.
      const { rows: recent } = await pool.query(
        `SELECT 1 FROM sdr_engagement_events
          WHERE pipedrive_lead_id = $1
            AND event_type IN ('email_replied','reply_received')
            AND occurred_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
        [lead.pipedrive_lead_id],
      );
      if (recent.length) continue; // already covered — no second task

      // Record a reply event so the next pass (and the Apollo poll's own dedup window) see it.
      await pool.query(
        `INSERT INTO sdr_engagement_events
           (source, event_type, apollo_event_id, pipedrive_lead_id, mailbox_email, occurred_at, payload, process_status, processed_at)
         VALUES ('gmail', 'email_replied', $1, $2, $3, NOW(), '{}'::jsonb, 'processed', NOW())
         ON CONFLICT (apollo_event_id) DO NOTHING`,
        [`gmail:${t.lastMessageId}:replied`, lead.pipedrive_lead_id, box.email],
      );

      try {
        const act = await pipedriveClient.addActivity({
          leadId: lead.pipedrive_lead_id,
          subject: `Reply received${contactEmail ? ` from ${contactEmail}` : ""} — follow up`,
          type: "task",
          done: false,
          userId: box.pipedrive_sender_id || DEREK_PD_USER_ID,
          note:
            `Replied to ${box.email} outreach — follow up.` +
            `\nOpen in interface: ${base}/#/sdr?inboxLead=${lead.pipedrive_lead_id}`,
        });
        await pipedriveClient.addNote({
          leadId: lead.pipedrive_lead_id,
          content:
            `[Auto] Inbox: REPLY received${contactEmail ? ` from ${contactEmail}` : ""} — hot lead, follow up.` +
            `${sequenceEjected ? "\nRemoved from Apollo sequence — no more follow-ups." : ""}` +
            `\nOpen in interface: ${base}/#/sdr?inboxLead=${lead.pipedrive_lead_id}`,
        });
        await pool.query(`UPDATE sdr_inbox_reply_log SET activity_id = $1 WHERE gmail_message_id = $2`, [
          String(act?.id || ""),
          t.lastMessageId,
        ]);
        created++;
      } catch (e) {
        console.error("[inbox-reply-watch] Pipedrive write failed:", e.message);
      }
    }
  }
  return { scanned, created, forwarded, bounced, skipped };
}

// Additive, gated path: collection only. External actions run independently in
// drainReplyActions; a saved observation never claims that forwarding/task succeeded.
async function collectReliableReplies(pool, { getToken, gmail = gmailInbox, classifyIntent = classifyReplyIntent, now = new Date(), maxPages = 4, runMailbox, reportingEnabled = process.env.SDR_REPORTING_INGEST_ENABLED === 'true' }) {
  const boxes = (await pool.query(`SELECT DISTINCT a.mailbox_email AS email FROM sdr_inbox_accounts a JOIN sdr_mailboxes m ON m.email=a.mailbox_email`)).rows;
  const counts = { scanned: 0, detected: 0, enqueued: 0, factsInserted:0, factsUpdated:0 };
  const mailboxes = [];
  let pages = 0;
  for (const box of boxes) {
    const work = async () => {
      await pool.query(`INSERT INTO sdr_inbox_watch_cursors(mailbox_email,enabled_since,high_water_at) VALUES($1,$2,$2) ON CONFLICT(mailbox_email) DO NOTHING`, [box.email,now]);
      const cursor = (await pool.query('SELECT * FROM sdr_inbox_watch_cursors WHERE mailbox_email=$1',[box.email])).rows[0];
      const token = await getToken(box.email);
      const after = cursor.scan_after || new Date(Math.max(+cursor.enabled_since,+cursor.high_water_at - 10 * 60000));
      let pageToken = cursor.page_token;
      let highest = cursor.scan_max_received_at || cursor.high_water_at;
      let lastMessage = cursor.scan_last_message_id || cursor.last_message_id;
      const mailboxCounts = { scanned: 0, detected: 0, enqueued: 0, pages: 0, factsInserted:0, factsUpdated:0 };
      const writeFact = async (msg,from,threadId,at,link,intent) => {
        if (!reportingEnabled) return;
        const fact = await observeInbound(pool,{id:msg.id,from_email:from,subject:msg.subject,received_at:at,thread_id:threadId},{mailbox:box.email,
          intent:intent.kind === 'auto' ? 'automatic' : intent.kind === 'bounce' ? 'bounce' : intent.label || 'unknown',leadLink:link,observedAt:now});
        counts.factsInserted += fact.inserted; counts.factsUpdated += fact.updated;
        mailboxCounts.factsInserted += fact.inserted; mailboxCounts.factsUpdated += fact.updated;
      };
      let invalidArrival = false;
      const tokensSeen = new Set();
      for (let page = 0; page < Math.min(20,Math.max(1,maxPages)); page++) {
        const result = await gmail.listThreadPage(token,{query:`-in:sent -in:spam -in:trash after:${Math.floor(+after / 1000)}`,pageToken,maxResults:25});
        if (!Array.isArray(result.threads)) throw new Error('invalid_gmail_page');
        pages++;
        mailboxCounts.pages++;
        for (const summary of result.threads) {
          let thread=summary;
          if(gmail.getThread) {
            try {
              const full=await gmail.getThread(token,summary.id);
              if(!Array.isArray(full.messages)) throw new Error('invalid_gmail_thread');
              thread={...summary,messages:full.messages};
            } catch { thread={...summary,contextUnavailable:true}; }
          }
          for (const msg of thread.messages || []) {
            if (msg.lastOutbound) continue;
            const at = new Date(msg.receivedAt);
            if (!msg.id || !msg.receivedAt || !Number.isFinite(+at)) { invalidArrival = true; continue; }
            if (+at < +cursor.enabled_since) continue;
            const from = (String(msg.from || '').match(/<?([^\s<>]+@[^\s<>]+)>?/) || [])[1]?.toLowerCase();
            if (/@proswppp\.(co|com)$/.test(from || '')) continue;
            mailboxCounts.scanned++;
            counts.scanned++;
            if (+at >= +highest) { highest = at; lastMessage = msg.id; }
            const canonical = msg.messageId && /^<[^\s<>]+@[^\s<>]+>$/.test(msg.messageId)
              ? `rfc822:${msg.messageId}` : `gmail:${box.email}:${msg.id}`;
            const existing = (await pool.query('SELECT * FROM sdr_reply_messages WHERE provider_message_id=$1',[canonical])).rows[0];
            if (existing) {
              await observeReplyThread(pool,{messageId:canonical,mailbox:box.email,thread,sourceMessageId:msg.id});
              const preservedLink=/^(?:gmail-thread:.+:outbound-message:|pipedrive:exact-rfc-message:)/.test(existing.link_evidence || '')
                ? {status:existing.link_status,leadId:existing.pipedrive_lead_id,evidence:existing.link_evidence}
                : {status:existing.pipedrive_lead_id ? 'ambiguous' : 'unlinked',evidence:'historical_link_requires_review'};
              await writeFact(msg,from,thread.id,existing.received_at,preservedLink,{kind:existing.reply_kind,label:existing.intent});
              continue;
            }
            if (+at < +after) continue;
            const klass = classifyInbound(msg.from,msg.subject,String(msg.snippet || msg.body || '').slice(0,4000));
            const body = msg.body || msg.snippet || '';
            let parts = (thread.participants || []).map(e=>String(e).toLowerCase()).filter(e=>!/@proswppp\.(co|com)$/.test(e));
            if (klass === 'bounce') parts = [extractFailedRecipient(`${msg.subject || ''} ${body}`)].filter(Boolean);
            const candidates = klass === 'auto' ? [] : (await pool.query('SELECT DISTINCT pipedrive_lead_id,lead_title FROM sdr_lead_state WHERE lower(person_email)=ANY($1::text[])',[parts])).rows;
            const link = await resolveReplyProject(pool,{mailbox:box.email,thread,message:msg,candidates});
            if (isTestContact(from,candidates[0]?.lead_title)) continue;
            let intent = { kind: klass || 'human',label: klass || 'unknown',worth:false };
            if (!klass) {
              try { intent = { ...await classifyIntent({from:msg.from,subject:msg.subject,body}),kind:'human' }; }
              catch { intent = {kind:'human',worth:true,label:'unknown'}; }
              if (!['interested','question','nurture','in_house','not_interested','unsubscribe','no_action'].includes(intent.label)) intent = {kind:'human',worth:true,label:'unknown'};
            }
            // Required before detection is claimed: failure preserves the cursor
            // for retry. Duplicate observations above can repair missing facts.
            await writeFact(msg,from,thread.id,at,link,intent);
            const saved = await enqueueReplyActions(pool,{messageId:canonical,sourceMessageId:msg.id,threadId:thread.id,mailbox:box.email,receivedAt:at,leadLink:link,intent,staffResponseAt:null});
            await observeReplyThread(pool,{messageId:canonical,mailbox:box.email,thread,sourceMessageId:msg.id});
            mailboxCounts.detected += saved.detected;
            mailboxCounts.enqueued += saved.enqueued;
            counts.detected += saved.detected;
            counts.enqueued += saved.enqueued;
          }
        }
        pageToken = result.nextPageToken || null;
        const complete = !pageToken && !invalidArrival;
        if (complete) {
          await pool.query(`UPDATE sdr_inbox_watch_cursors SET high_water_at=$2,last_message_id=$3,page_token=NULL,scan_after=NULL,scan_max_received_at=NULL,scan_last_message_id=NULL WHERE mailbox_email=$1`,[box.email,highest,lastMessage]);
        } else {
          await pool.query(`UPDATE sdr_inbox_watch_cursors SET page_token=$2,scan_after=$3,scan_max_received_at=$4,scan_last_message_id=$5 WHERE mailbox_email=$1`,[box.email,pageToken,after,highest,lastMessage]);
        }
        if (!pageToken) return {coverage:complete ? 'complete' : 'partial',counts:mailboxCounts};
        if (tokensSeen.has(pageToken)) return {coverage:'partial',counts:mailboxCounts};
        tokensSeen.add(pageToken);
      }
      return {coverage:'partial',counts:mailboxCounts};
    };
    try {
      const result = await (runMailbox ? runMailbox(box.email,work) : work());
      mailboxes.push({mailbox:box.email,status:result.coverage || 'partial',counts:result.counts});
    } catch (error) { mailboxes.push({mailbox:box.email,status:'failed',errorCategory:safeErrorCategory(error)}); }
  }
  return {coverage:mailboxes.every(m=>m.status === 'complete') ? 'complete' : 'partial',counts,pages,mailboxes};
}

// Record an inbound NDR (bounce) that Apollo may not have flagged: find the failed prospect by
// the address quoted in the NDR, leave a "bounced" comment on the lead, mark the send bounced,
// clear Sequence_Started, and pull the contact from Apollo so we stop sending to a dead address.
// Deduped against any bounce event on the lead in the last 48h so it stays one note across paths.
async function recordInboxBounce(pool, token, t, box, base) {
  // Build the searchable NDR text (subject + snippet + full body) and pull the failed address.
  let body = "";
  try {
    const full = await gmailInbox.getThread(token, t.id);
    body = (full.messages || []).map((m) => m.body || "").join("\n");
  } catch {
    /* body is best-effort; subject + snippet usually carry the address too */
  }
  const failed = extractFailedRecipient(`${t.subject || ""} ${t.snippet || ""} ${body}`);
  if (!failed) return false;

  const { rows: leadRows } = await pool.query(
    `SELECT pipedrive_lead_id, lead_title FROM sdr_lead_state WHERE lower(person_email) = $1 LIMIT 1`,
    [failed],
  );
  const lead = leadRows[0];
  if (!lead) return false; // not a known SDR lead
  await pool.query(`UPDATE sdr_inbox_reply_log SET pipedrive_lead_id = $1 WHERE gmail_message_id = $2`, [
    lead.pipedrive_lead_id,
    t.lastMessageId,
  ]);

  // Dedup: if a bounce was already recorded for this lead in the last 48h (Apollo or a prior
  // pass), don't double-note. Stable synthetic event id makes the insert itself idempotent too.
  const { rows: recent } = await pool.query(
    `SELECT 1 FROM sdr_engagement_events
      WHERE pipedrive_lead_id = $1 AND event_type IN ('email_bounced','bounce')
        AND occurred_at > NOW() - INTERVAL '48 hours' LIMIT 1`,
    [lead.pipedrive_lead_id],
  );
  await pool.query(
    `INSERT INTO sdr_engagement_events
       (source, event_type, apollo_event_id, pipedrive_lead_id, mailbox_email, occurred_at, payload, process_status, processed_at)
     VALUES ('gmail', 'email_bounced', $1, $2, $3, NOW(), '{}'::jsonb, 'processed', NOW())
     ON CONFLICT (apollo_event_id) DO NOTHING`,
    [`gmail:${t.lastMessageId}:bounced`, lead.pipedrive_lead_id, box.email],
  );
  if (recent.length) return true; // already flagged — event recorded, but no second note

  // Mark the send bounced + grab the Apollo handle so we can stop the sequence.
  const { rows: sendRows } = await pool.query(
    `UPDATE sdr_sends SET status = 'bounced', last_status_at = NOW(), updated_at = NOW()
      WHERE pipedrive_lead_id = $1 AND status IN ('enrolled','sent')
      RETURNING id, apollo_contact_id, apollo_sequence_id`,
    [lead.pipedrive_lead_id],
  );

  try {
    await pipedriveClient.addNote({
      leadId: lead.pipedrive_lead_id,
      content: `[Auto] BOUNCED — delivery failed to ${failed} (rejected by the recipient's mail server). Provider stop needs review.`,
    });
  } catch (e) {
    console.error("[inbox-reply-watch] Pipedrive bounce write failed:", e.message);
  }

  // Hard-stop remaining Apollo follow-ups to the bouncing address.
  const snd = sendRows[0];
  if (snd?.apollo_contact_id && snd?.apollo_sequence_id && process.env.APOLLO_API_KEY) {
    try {
      await stopOwnedEnrollment({pool,apollo:apolloClient,actionId:`inbox-bounce:${t.lastMessageId}:${snd.id}`,expected:{
        contactId:snd.apollo_contact_id,campaignId:snd.apollo_sequence_id,sendId:snd.id,leadId:lead.pipedrive_lead_id,membershipId:null,addedAt:null,
      }});
    } catch (e) {
      console.error("[inbox-reply-watch] Apollo remove-on-bounce failed:", e.message);
    }
  }
  return true;
}
