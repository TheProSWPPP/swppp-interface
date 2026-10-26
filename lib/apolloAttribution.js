// Project + source attribution for Apollo sequence messages that match one of OUR
// enrollments (an sdr_sends row). Shared by the live engagement poll and the one-time
// history backfill (tools/backfill-apollo-attribution.mjs) so both write the same thing.
//
// Source = the construction trigger the project was enrolled under (AGC, LBA, PB, CM).
// It is always known for a real enrollment: the send row records it (enrolled_trigger),
// the approved draft records it (trigger_type), and each trigger has its own sequence
// (APOLLO_SEQ_<TRIGGER>). A lead's CRM origin field is blank for about a third of sends,
// so it cannot be the reporting source.
const TRIGGER = /^[A-Z]{2,8}$/;

export function normalizeTrigger(value) {
  const trigger = String(value ?? '').trim().toUpperCase();
  return TRIGGER.test(trigger) ? trigger : null;
}

/** APOLLO_SEQ_<TRIGGER>=<sequence id> → trigger. Only plain trigger names count. */
export function sequenceTriggerFromEnv(sequenceId, env = process.env) {
  if (!sequenceId) return null;
  for (const [key, value] of Object.entries(env)) {
    const match = /^APOLLO_SEQ_([A-Z]{2,8})$/.exec(key);
    if (match && String(value || '').trim() === String(sequenceId)) return match[1];
  }
  return null;
}

export function sourceKeyForSend(send, sequenceId, env = process.env) {
  return normalizeTrigger(send?.enrolled_trigger) || normalizeTrigger(send?.draft_trigger_type)
    || sequenceTriggerFromEnv(sequenceId, env) || 'unknown';
}

/**
 * observeOutbound options for a message matched to one of our own enrollments. The match
 * evidence names the send row; the classification says why this is sales outreach (it was
 * sent by a sequence enrollment this app created for that project).
 */
export function sendAttribution(send, evidence, sequenceId, env = process.env) {
  return {
    leadLink: { status: 'verified', leadId: send.pipedrive_lead_id || null, evidence, sourceKey: sourceKeyForSend(send, sequenceId, env) },
    outreachClassification: 'sales_outreach',
    classificationEvidence: `sdr_send:${send.id}:apollo_sequence:${sequenceId}`,
  };
}
