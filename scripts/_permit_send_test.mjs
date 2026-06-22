// Production-level permits test: send EXACTLY 1 real email through the permits'
// own MSGP Apollo sequence, from a .co cold mailbox, to a controlled inbox.
// Env: APOLLO_API_KEY, DBURL, TO. Guarded: 1 contact, 1-step sequence.
import pg from "pg";
import * as apollo from "../lib/apolloClient.js";

const MSGP_SEQ = "6a32587c8a5c33001c728b9f";
const CF_SUBJECT = "6a2adb32a2b9130020474786";
const CF_BODY = "6a2adb32bfaa320020f80f97";
const CF_TRACK = "6a32559593e27d000c4ee92f";
const SENDER_EMAIL = "dc@proswppp.co";
const TO = process.env.TO;
if (!TO) { console.error("TO required"); process.exit(1); }

// blue Georgia wrapper, same as the live SDR sequences (body merged from field)
const STEP_BODY = `<div style="font-family:Georgia,'Times New Roman',serif;color:#1a5276;font-size:15px;line-height:1.55">{{contact.swppp_draft_body}}</div>`;
const STEP_SUBJECT = "{{contact.swppp_draft_subject}}";

const pool = new pg.Pool({ connectionString: process.env.DBURL, ssl: { rejectUnauthorized: false } });

// 1. Pull the stored MSGP copy + a real hot operator name, render to plain text.
const tpl = (await pool.query(`SELECT subject, body_html FROM permit_msgp_template WHERE id=1`)).rows[0];
const op = (await pool.query(`
  SELECT f.operator_name, MAX((f.compliance_flags->>'pain')::int) pain
    FROM permit_facilities f WHERE f.operator_name IS NOT NULL
   GROUP BY f.operator_name ORDER BY pain DESC NULLS LAST LIMIT 1`)).rows[0];
await pool.end();

const htmlToText = (h) => h
  .replace(/<\/p>/gi, "\n\n").replace(/<br\s*\/?>(?=)/gi, "\n")
  .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'")
  .replace(/\n{3,}/g, "\n\n").trim();

const subject = tpl.subject;
const body = htmlToText(tpl.body_html)
  .replace(/\{\{first_name\}\}/g, "Ivan")
  .replace(/\{\{operator\}\}/g, op.operator_name)
  // signature lines are tight in the HTML (margin:0) — collapse the blank lines
  .replace(/Regards,\n\n+Derek/, "Regards,\nDerek")
  .replace(/Founder\n\n+Pro SWPPP, LLC/, "Founder\nPro SWPPP, LLC")
  .replace(/Pro SWPPP, LLC\n\n+www/, "Pro SWPPP, LLC\nwww");

console.log(`Operator merged: ${op.operator_name} (pain ${op.pain})`);
console.log(`--- rendered body ---\n${body}\n---------------------`);

// 2. Point the step's template at the merge fields, exact blue-Georgia wrapper.
const detail = await apollo.getSequenceDetail(MSGP_SEQ);
const templates = detail.emailer_templates || [];
if (!templates.length) { console.error("MSGP sequence has NO step/template — add an email step in Apollo first."); process.exit(1); }
const tplId = templates[0].id;
await apollo.updateEmailerTemplate(tplId, { subject: STEP_SUBJECT, body_html: STEP_BODY });
console.log(`Step template ${tplId} set.`);

// 3. Activate the sequence.
try { await apollo.activateSequence(MSGP_SEQ); console.log("Sequence activated."); }
catch (e) { console.log("activate:", e.message); }

// 4. Resolve sender mailbox id.
const accts = await apollo.listEmailAccounts();
const mb = accts.find((a) => (a.email || "").toLowerCase() === SENDER_EMAIL);
if (!mb) { console.error(`Mailbox ${SENDER_EMAIL} not found in Apollo`); process.exit(1); }
console.log(`Sender mailbox: ${mb.email} (${mb.id})`);

// 5. Create/find the ONE test contact + set custom fields.
const { id: contactId, created } = await apollo.matchContactByEmail(TO);
console.log(`Test contact ${TO} → ${contactId} (created=${created})`);
await apollo.updateContactCustomFields(contactId, {
  [CF_SUBJECT]: subject,
  [CF_BODY]: body,
  [CF_TRACK]: "permit-test",
});
console.log("Custom fields set.");

// 6. Enroll the one contact → Apollo sends step-1.
// Override Apollo's "active in other campaigns" dedup so the test contact enrolls;
// allow unverified just in case (harmless for a real verified inbox).
const resp = await apollo.addContactsToSequence(MSGP_SEQ, [contactId], mb.id, {
  sequence_active_in_other_campaigns: true,
  sequence_unverified_email: true,
});
const added = (resp.contacts || []).length;
const skipped = resp.skipped_contact_ids || {};
console.log(`Enroll: added=${added} skipped=${JSON.stringify(skipped)}`);
if (!added) { console.error("STILL SKIPPED — not sent."); process.exit(1); }
console.log("DONE — 1 contact enrolled into single-step MSGP sequence. Apollo will send shortly.");
