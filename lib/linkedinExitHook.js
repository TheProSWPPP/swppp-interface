// Reply exit hook for the LinkedIn prospect lanes (lib/sdrLinkedinProspect.js, PR #124): a reply
// anywhere holds the person's LinkedIn lane and cancels its pending actions. Registered at boot
// next to the bid invite hook, so a reply stops bid emails and LinkedIn together, both through
// #125's exit_person and through the bid invite engine's own reply detection.
// Inert until migrations/2026-11-03-sdr-linkedin-prospects.sql exists. Idempotent (only active
// candidates are held). Never sends anything.
import { registerExitHook } from "./replyExit.js";
import { holdLinkedinLaneForPerson } from "./sdrLinkedinProspect.js";

async function lanesReady(db) {
  const { rows } = await db.query(`SELECT to_regclass('sdr_linkedin_candidates') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='sdr_linkedin_candidates' AND column_name='resolved_email') AS ready`);
  return rows[0]?.ready === true;
}

export async function holdLinkedinForExit(pool, { companyId, emails = [] } = {}) {
  if (!companyId || !emails.length || !(await lanesReady(pool))) return { cancelled: 0 };
  let cancelled = 0;
  for (const email of [...new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))])
    cancelled += (await holdLinkedinLaneForPerson(pool, { companyId, email, reason: "email_reply" })).held || 0;
  return { cancelled };
}

export function registerLinkedinExitHook(pool, { companyId = process.env.SDR_CRM_COMPANY_ID } = {}) {
  return registerExitHook("linkedin_prospect_lanes", {
    exit: ({ emails }) => holdLinkedinForExit(pool, { companyId, emails }),
  });
}
