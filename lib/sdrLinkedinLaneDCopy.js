// Lane D: the {topic} and {reaction} for one person's stormwater post. The model writes them,
// they are stored unverified, and the candidate stays in copy_review until an admin approves.
import { auditLinkedinAdmin } from './sdrLinkedinAdmin.js';

const fail = code => Object.assign(new Error(code), { code });
const MODEL = () => process.env.SDR_LINKEDIN_LINE_MODEL || process.env.REPLY_INTENT_MODEL || 'gemini-3.6-flash';
const words = (value, max) => String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/[—–]/g, ',').trim().split(' ').slice(0, max).join(' ');

export function laneDPrompt({ post, person }) {
  return [
    'You help a stormwater (SWPPP) company owner write one line of a LinkedIn message to someone whose post he read.',
    'The message reads: "Saw your post about {topic}, {reaction}. We write SWPPPs for GCs in {state}, so that one hit home."',
    'Write {topic}: what the post is about, at most 6 words, lower case unless a proper noun, no trailing punctuation.',
    'Write {reaction}: a short honest reaction to that post, at most 14 words, lower case start, no trailing punctuation.',
    'Reference only what the post says. Make no claims about us or our work, no price, no questions, no emojis, no dashes.',
    `Author: ${person?.title || 'unknown title'} at ${person?.company || 'unknown company'}.`,
    `Post:\n"""${String(post?.text || '').slice(0, 2500)}"""`,
    'Respond with ONLY minified JSON: {"topic":"...","reaction":"..."}',
  ].join('\n');
}

export async function draftLaneDLines({ post, person, apiKey = process.env.GEMINI_API_KEY, transport = fetch }) {
  if (!apiKey || !post?.text) return null;
  try {
    const response = await transport(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: laneDPrompt({ post, person }) }] }], generationConfig: { temperature: 0.4, responseMimeType: 'application/json' } }),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const topic = words(parsed.topic, 6).replace(/[.!?]+$/, ''), reaction = words(parsed.reaction, 14).replace(/[.!?]+$/, '');
    if (!topic || !reaction || /\?/.test(reaction) || /\$/.test(`${topic}${reaction}`)) return null;
    return { topic, reaction };
  } catch { return null; }
}

// Approve (with any edits) or reject one lane D line. Approval marks both facts verified and
// moves the candidate to reviewed, so it can join the lane D campaign. Rejecting archives it.
export async function approveLaneDCopy(pool, { companyId, accountId, candidateId, expectedRevision, topic, reaction, decision = 'approve', actor, now = new Date() }) {
  if (!Number.isInteger(expectedRevision) || !actor || !['approve', 'reject'].includes(decision)) throw fail('invalid_request');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const current = (await db.query('SELECT * FROM sdr_linkedin_candidates WHERE company_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE', [companyId, accountId, candidateId])).rows[0];
    if (!current) throw fail('candidate_unavailable');
    if (current.revision !== expectedRevision) throw fail('revision_conflict');
    if (current.lane !== 'D' || current.state !== 'copy_review') throw fail('candidate_not_in_copy_review');
    let row;
    if (decision === 'reject') {
      row = (await db.query(`UPDATE sdr_linkedin_candidates SET state='archived',hold_reason='lane_d_copy_rejected',revision=revision+1 WHERE id=$1 RETURNING *`, [candidateId])).rows[0];
    } else {
      const t = words(topic, 6), r = words(reaction, 14);
      if (!t || !r) throw fail('copy_line_required');
      const at = new Date(now).toISOString();
      const context = current.source_context || {};
      const facts = { ...(context.facts || {}), topic: { value: t, verified: true, evidenceRef: `lane_d_review:${actor}`, approvedBy: actor, approvedAt: at, observedAt: at }, reaction: { value: r, verified: true, evidenceRef: `lane_d_review:${actor}`, approvedBy: actor, approvedAt: at, observedAt: at } };
      row = (await db.query(`UPDATE sdr_linkedin_candidates SET state='reviewed',source_context=$2,revision=revision+1 WHERE id=$1 RETURNING *`, [candidateId, JSON.stringify({ ...context, facts })])).rows[0];
    }
    await auditLinkedinAdmin(db, { companyId, accountId, actor, action: decision === 'reject' ? 'lane_d.reject' : 'lane_d.approve', targetId: candidateId, detail: { revision: current.revision } });
    await db.query('COMMIT');
    return row;
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
}
