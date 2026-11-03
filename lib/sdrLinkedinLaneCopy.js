// Derek's LinkedIn lane copy, word for word from the client page
// output/reports/ProSWPPP-Bid-Invites-and-LinkedIn.html (Part 2, 2026-11-03).
// This is the only place the copy lives. Derek's edits replace it per lane through the
// campaign revision route, which leaves the campaign unapproved until it is approved again.
//
// Placeholders: {firstName} {company} {newCompany} {oldCompany} {lastProject} {topic} {reaction} {state}.
// [[ ... ]] marks an optional clause. It is dropped whole when any fact inside it is unverified.
export const LANES = ['A', 'B', 'C', 'D'];

const A_FOLLOWUP1 = "Hey {firstName}, first few months in a new seat usually means rebuilding the sub list. Worth having a SWPPP guy on it who actually picks up the phone?";
const A_FOLLOWUP2 = "Hey {firstName}, I'll stop sliding into your DMs about stormwater after this one 😄 If a SWPPP ever lands on your desk, send it my way.";
const INMAIL = {
  subject: 'SWPPPs at {company}',
  body: "Hey {firstName}, congrats on the new role. I'm Derek, I run ProSWPPP. We write the SWPPPs for GCs in {state}. If you're putting your sub list together, I'd love to be on it. Worth a 10 minute call?",
};

export const LANE_COPY = Object.freeze({
  A: Object.freeze({
    dm1: "Hey {firstName}, appreciate the connection. Congrats on the new role at {company}. Who's handling the SWPPPs over there these days?",
    followup1: A_FOLLOWUP1,
    followup2: A_FOLLOWUP2,
    inmail: Object.freeze({ ...INMAIL }),
    followupDays: Object.freeze([3, 7]),
  }),
  B: Object.freeze({
    dm1: "Hey {firstName}, saw you made the move to {newCompany}. Congrats man. We miss doing your SWPPPs from the {oldCompany} days. Who's handling stormwater over there?",
    followup1: "Hey {firstName}, if y'all have anything coming up at {newCompany} that needs a SWPPP, send it over and we'll take care of you like old times.",
    // Lane B's {company} is the new company, so the shared InMail reads "SWPPPs at {newCompany}".
    inmail: Object.freeze({ ...INMAIL }),
    followupDays: Object.freeze([4]),
  }),
  C: Object.freeze({
    dm1: "Hey {firstName}, appreciate the connection. We've done the SWPPPs for {company} for a while[[, most recently {lastProject}]]. Wanted to say hi since you're the new go-to for precon.",
    followup1: "Hey {firstName}, anything coming up at {company} that needs a SWPPP? Happy to bid it.",
    followupDays: Object.freeze([4]),
  }),
  D: Object.freeze({
    dm1: "Hey {firstName}, appreciate the connection. Saw your post about {topic}, {reaction}. We write SWPPPs for GCs in {state}, so that one hit home.",
    followup1: A_FOLLOWUP1,
    followup2: A_FOLLOWUP2,
    followupDays: Object.freeze([3, 7]),
  }),
});

export const laneHasInmail = lane => lane === 'A' || lane === 'B';

// The campaign defaults for one lane: copy keys match the policy's step names.
export function laneCampaignDefaults(lane) {
  const source = LANE_COPY[lane];
  if (!source) throw Object.assign(new Error('invalid_lane'), { code: 'invalid_lane' });
  const copy = { dm1: source.dm1, followup1: source.followup1 };
  if (source.followup2) copy.followup2 = source.followup2;
  if (source.inmail) copy.inmail = { subject: source.inmail.subject, body: source.inmail.body };
  return { copy, followupDays: [...source.followupDays], inmail: laneHasInmail(lane) };
}
