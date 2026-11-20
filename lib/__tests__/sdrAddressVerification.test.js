import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reportingTestDb } from "./reportingTestDb.js";
import { checkSdrAddress } from "../sdrAddressVerification.js";
import { checkDraftEmail } from "../sdrDraftVerify.js";
import { verifyOneLead } from "../emailVerifyRefresh.js";

const db = reportingTestDb("address_verification");
const address = "contact+bid@example.test";
const target = { leadId: "target", email: address, companyId: "tenant" };
const noLive = vi.fn(async () => { throw new Error("unexpected provider call"); });
const q = (...args) => db.pool.query(...args);
const row = async id => (await q("SELECT *,email_verified_at::text AS observed,email_soft_rechecked_at::text AS rechecked FROM sdr_lead_state WHERE pipedrive_lead_id=$1",[id])).rows[0];
async function insert(id, { company="tenant", email=address, value=null, status=null, age="1 day", recheck=false } = {}) {
  await q(`INSERT INTO sdr_lead_state VALUES ($1,$2,$3,$4,$5,
    CASE WHEN $4::text IS NOT NULL THEN date_trunc('second',now()) - $6::interval + interval '0.123456 seconds' END,
    CASE WHEN $7 THEN date_trunc('second',now()) - $6::interval + interval '0.123457 seconds' END,
    $1||'-flag',$1||'-resolved')`,[id,company,email,value,status,age,recheck]);
}
describe.skipIf(!db)("SDR verification evidence for an exact address", () => {
  beforeAll(async () => {
    await db.setup();
    await q(`CREATE TABLE sdr_lead_state(pipedrive_lead_id text PRIMARY KEY,crm_company_id text,person_email text,
      email_verified_value text,email_verify_status text,email_verified_at timestamptz,email_soft_rechecked_at timestamptz,
      email_flag text,resolved_email text)`);
  });
  beforeEach(async () => { noLive.mockClear(); await q("TRUNCATE sdr_lead_state"); });
  afterAll(async () => { await db.close(); });

  it("reuses the newest matching evidence, keeps its microseconds and the recipient's own flags", async () => {
    await insert("target",{email:" Contact+Bid@Example.Test ",value:address,status:"valid",age:"20 days"});
    await insert("donor",{value:"\t CONTACT+BID@example.test \r",email:"now-different@example.test",status:"do_not_mail"});
    await insert("similar",{value:"contact@example.test",status:"valid",age:"1 minute"});
    await insert("other-company",{company:"other",value:address,status:"valid",age:"1 minute"});
    const before = await row("donor");
    const result = await checkSdrAddress(db.pool,target,{verifyEmail:noLive});
    expect(result).toMatchObject({ok:false,status:"do_not_mail",verifiedAt:before.observed,cached:true,email_flag:"target-flag",resolved_email:"target-resolved"});
    expect(await row("target")).toMatchObject({email_verified_value:" Contact+Bid@Example.Test ",email_verify_status:"hard_fail",observed:before.observed,email_flag:"target-flag",resolved_email:"target-resolved"});
    expect(await row("donor")).toEqual(before);
    expect(noLive).not.toHaveBeenCalled();
  });

  it.each([null,"", "other"])("does not borrow from a different or unknown company (%s)", async company => {
    await insert("target",{company});
    await insert("donor",{value:address,status:"valid"});
    const verifyEmail=vi.fn(async()=>({ok:true,status:"catch_all"}));
    const r=await checkSdrAddress(db.pool,{leadId:"target",email:address},{verifyEmail});
    expect(r).toMatchObject({cached:false,status:"catch_all"});
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect((await row("target")).email_verify_status).toBe("soft");
  });

  it("preserves legacy own-row evidence even without a company and never crosses two unknown companies",async()=>{
    await insert("target",{company:null,value:address,status:"unknown",age:"2 days"});
    await insert("donor",{company:null,value:address,status:"valid",age:"1 day"});
    const r=await checkSdrAddress(db.pool,{leadId:"target",email:address},{verifyEmail:noLive});
    expect(r).toMatchObject({cached:true,status:"unknown",ok:true});
  });

  it.each([
    ["garbled", "1 day", "garbled"], ["constructor","1 day","constructor"], ["valid","100 days","valid"],
    ["valid","-1 day","valid"],
  ])("requires a live verdict for %s at age %s",async(_case,age,status)=>{
    await insert("target");
    await insert("donor",{value:address,status,age});
    const verifyEmail=vi.fn(async()=>({ok:true,skipped:true}));
    const r=await checkSdrAddress(db.pool,target,{verifyEmail});
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(r.skipped).toBe(true);
    expect((await row("target")).email_verified_at).toBeNull();
  });

  it("refuses a newer unrecognized status over an older positive; a new provider answer replaces it",async()=>{
    await insert("target",{value:address,status:"valid",age:"4 days"});
    await insert("donor",{value:address,status:"provider_added_status"});
    const verifyEmail=vi.fn(async()=>({ok:true,status:"unknown"}));
    const r=await checkSdrAddress(db.pool,target,{verifyEmail});
    expect(r).toMatchObject({cached:false,status:"unknown"});
    expect((await row("target")).email_verify_status).toBe("soft");
  });

  it("refuses conflicting positive/soft ties and gives precedence to a hard failure at the same instant",async()=>{
    await insert("target");
    await insert("a",{value:address,status:"valid"});
    await insert("b",{value:address,status:"catchall"});
    await q("UPDATE sdr_lead_state SET email_verified_at=(SELECT email_verified_at FROM sdr_lead_state WHERE pipedrive_lead_id='a') WHERE pipedrive_lead_id='b'");
    expect((await checkSdrAddress(db.pool,target,{cacheOnly:true})).skipped).toBe(true);
    await q("UPDATE sdr_lead_state SET email_verify_status='spamtrap' WHERE pipedrive_lead_id='b'");
    expect(await checkSdrAddress(db.pool,target,{verifyEmail:noLive})).toMatchObject({ok:false,status:"spamtrap",cached:true});
  });

  it("materializes an overdue soft result unchanged in cache-only mode, then shares a single real recheck",async()=>{
    await insert("target");
    await insert("donor",{value:address,status:"unknown",age:"8 days"});
    const donor = await row("donor");
    const dry = await checkSdrAddress(db.pool,target,{readOnly:true});
    expect(dry).toMatchObject({cached:true,recheckDue:true,verifiedAt:donor.observed,softRecheckedAt:null});
    expect((await row("target")).email_verified_at).toBeNull();
    const adopted=await checkSdrAddress(db.pool,target,{cacheOnly:true});
    expect(adopted).toMatchObject({cached:true,recheckDue:true,verifiedAt:donor.observed,softRecheckedAt:null});
    const verifyEmail=vi.fn(async()=>({ok:true,status:"catchall",soft:"catchall"}));
    const first=await checkSdrAddress(db.pool,target,{verifyEmail});
    expect(first).toMatchObject({cached:false,softRecheckedAt:first.verifiedAt});
    const second=await checkSdrAddress(db.pool,{...target,leadId:"donor"},{verifyEmail});
    expect(second).toMatchObject({cached:true,verifiedAt:first.verifiedAt,softRecheckedAt:first.verifiedAt});
    expect(verifyEmail).toHaveBeenCalledTimes(1);
  });

  it("concurrent draft/refresh checks for two leads pay once; both receive the same observation",async()=>{
    await insert("target");
    await insert("second",{email:address.toUpperCase()});
    const verifyEmail = vi.fn(async()=>({ok:true,status:"valid"}));
    const [draft, refresh]=await Promise.all([
      checkDraftEmail(db.pool,target,{verifyEmail}),
      verifyOneLead(db.pool,{leadId:"second",email:address.toUpperCase()},{verify:verifyEmail,canUseApollo:()=>false}),
    ]);
    expect(draft.blocked).toBeNull();
    expect(refresh.status).toBe("valid");
    expect(verifyEmail).toHaveBeenCalledExactlyOnceWith(address);
    expect((await row("second")).observed).toBe((await row("target")).observed);
  });

  it("returns a hard-fail to draft and per-lead checks from cache without using the recovery cascade",async()=>{
    await insert("target");await insert("donor",{value:address,status:"abuse"});
    const result=await verifyOneLead(db.pool,target,{verify:noLive,listOrgPersons:noLive,canUseApollo:noLive});
    expect(result).toMatchObject({cached:true,status:"hard_fail",email_flag:"target-flag",resolved_email:"target-resolved"});
    expect((await checkDraftEmail(db.pool,target,{verifyEmail:noLive})).blocked).toMatchObject({sub_status:null});
    expect(noLive).not.toHaveBeenCalled();
  });

  it("reuses an alternate's evidence only while the original primary matches and leaves ownership with the original person",async()=>{
    await insert("target",{value:address,status:"hard_fail"});
    await insert("donor",{value:"other@example.test",email:"other@example.test",status:"valid"});
    const before = await row("target");
    const r = await checkSdrAddress(db.pool, {leadId:"target",email:"other@example.test"}, {alternateFor:address,verifyEmail:noLive});
    expect(r).toMatchObject({cached:true,ok:true});
    expect(await row("target")).toEqual(before);
    const changed = await checkSdrAddress(db.pool,{leadId:"target",email:"other@example.test"},{alternateFor:"changed@example.test",verifyEmail:noLive});
    expect(changed.skipped).toBe(true);
  });

  it("never spends or writes on an explicit scope mismatch, and never treats a malformed address as valid",async()=>{
    await insert("target",{value:address,status:"valid"});
    expect((await checkSdrAddress(db.pool,{...target,companyId:"other"},{verifyEmail:noLive})).skipped).toBe(true);
    expect((await checkSdrAddress(db.pool,{...target,email:"changed@example.test"},{verifyEmail:noLive})).skipped).toBe(true);
    await q("UPDATE sdr_lead_state SET person_email='na',email_verified_value='na'");
    const r=await checkSdrAddress(db.pool,{...target,email:"na"});
    expect(r).toMatchObject({ok:false,cached:false,sub_status:"not_an_email_address"});
    expect((await row("target")).email_verify_status).toBe("hard_fail");
  });
});
