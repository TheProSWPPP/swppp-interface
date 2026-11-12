import { describe, it, expect, vi } from 'vitest';
import { planFromCsv } from '../bidInviteCsvPreview.js';
import { renderPreviewHtml } from '../bidInviteEngine.js';
import { parseArgs, pilotLeadIds } from '../../scripts/bid-invite-dry-run.mjs';

const CSV = [
  'Company,Contact Name,Primary Email,Phone,Bid Date,Project Title,Quick Link,Platform',
  'Caffey Construction,Rodger Caffey,rodger@gc.test,,10/01/2026,"Zavala County Jail - Sitework",https://app.buildingconnected.com/x,BC',
  'Caffey Construction,Rodger Caffey,Rodger@gc.test,,10/10/2026,"Fort Bend ISD Natatorium (Bid Package 2)",,BC',
  'Caffey Construction,Rodger Caffey,rodger@gc.test,,10/20/2026,Wharton SWPPP,,CC',
  'Caffey Construction,Rodger Caffey,rodger@gc.test,,9/15/26,Bay City Clinic,,CC',
  'Gulf Builders,Kim Lee,kim@gulf.test,,Sep 20 2026,"UTMB CLC Parking Lot, All Trades",,ISQFT',
  'Old Co,Sam,sam@old.test,,8/20/2026,Old Job,,Other',
  'No Mail Co,Pat,,,10/01/2026,Some Job,,Other',
  'Junk Co,Al,al@junk.test,,soon,Junk Job,,Other',
].join('\n');

describe('CSV dry run (before import)', () => {
  const now = new Date('2026-11-03T15:00:00Z');
  it('groups by contact, names 3, counts holds and renders the page wording', async () => {
    const r = await planFromCsv([{ name: 'bids.csv', text: CSV }], { now });
    expect(r.counts).toMatchObject({ rows: 8, batches: 2, grouped_batches: 1, customer_check: 'skipped' });
    expect(r.holds).toMatchObject({ before_min_bid_date: 1, no_email: 1, no_bid_date: 1 });
    const grouped = r.samples.find((s) => s.step === 'e1' && s.to === 'rodger@gc.test');
    expect(grouped.subject).toBe('Your recent bids');
    expect(grouped.bodyText.split('\n\n').slice(0, 3)).toEqual(["Rodger, did y'all win any of these?", 'Wharton, Fort Bend ISD Natatorium, Zavala County Jail and 1 more.', 'You should have a bid from us on each one.']);
    expect(grouped.leads).toHaveLength(4);
    expect(grouped.leads.filter((l) => !l.named)).toHaveLength(1);
    const single = r.samples.find((s) => s.step === 'e1' && s.to === 'kim@gulf.test');
    expect(single.subject).toBe('UTMB CLC Parking Lot SWPPP');
    expect(single.bodyText).toBe("Kim, did y'all win this UTMB CLC Parking Lot?\n\nYou should have a bid from us on the SWPPP.\n\nIf everything looks good on it, just let us know how quick you need it.\n\nWe appreciate it.\n\nRegards,\nDerek E. Chinners - Founder\nPro SWPPP, LLC\nwww.ProSWPPP.com");
  });
  it('a City or State column on the sheet reaches the email: city, state term, subject', async () => {
    const withCity = [
      'Company,Contact Name,Primary Email,Bid Date,Project Title,City,State,Platform',
      'Gulf Builders,Kim Lee,kim@gulf.test,Sep 20 2026,"Mobile Clinic, All Trades",Mobile,AL,ISQFT',
      'Peach Co,Ann Day,ann@peach.test,Sep 21 2026,Macon Depot,,GA,BC',
    ].join('\n');
    const r = await planFromCsv([{ name: 'bids.csv', text: withCity }], { now, signature: '' });
    const al = r.samples.find((s) => s.step === 'e1' && s.to === 'kim@gulf.test');
    expect(al.subject).toBe('Mobile Clinic CBMPP');
    expect(al.bodyText.split('\n\n').slice(0, 2)).toEqual(["Kim, did y'all win this Mobile Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
    const ga = r.samples.find((s) => s.step === 'e1' && s.to === 'ann@peach.test');
    expect(ga.bodyText.split('\n\n').slice(0, 2)).toEqual(["Ann, did y'all win this Macon Depot?", 'You should have a bid from us on the ES&PC Plan.']);
    expect(r.samples.find((s) => s.step === 'e2' && s.to === 'kim@gulf.test')?.subject ?? 'Re: Mobile Clinic CBMPP').toBe('Re: Mobile Clinic CBMPP');
  });
  it('a location that already ends in a state is kept; a conflicting State column or a placeholder city leaves the city out', async () => {
    const { normalizeLeadCsv, parseCsv } = await import('../leadCsvNormalize.js');
    const rows = [
      'Company,Contact Name,Primary Email,Bid Date,Project Title,Location,State,Platform',
      'A Co,Kim Lee,a@a.test,Sep 20 2026,Clinic,Mobile AL,AL,BC',
      'B Co,Kim Lee,b@b.test,Sep 20 2026,Clinic,Mobile AL,GA,BC',
      'C Co,Kim Lee,c@c.test,Sep 20 2026,Clinic,"Mobile, AL 36602",Alabama,BC',
      'D Co,Kim Lee,d@d.test,Sep 20 2026,Clinic,N.A.,AL,BC',
      'E Co,Kim Lee,e@e.test,Sep 20 2026,Clinic,NULL,AL,BC',
      'F Co,Kim Lee,f@f.test,Sep 20 2026,Clinic,Santa Fe,NM,BC',
      'G Co,Kim Lee,g@g.test,Sep 20 2026,Clinic,"Atlanta, GA",TX,BC',
      'H Co,Kim Lee,h@h.test,Sep 20 2026,Clinic,"Mobile, AL, USA",GA,BC',
      'I Co,Kim Lee,i@i.test,Sep 20 2026,Clinic,"Mobile, AL, USA",AL,BC',
      'J Co,Kim Lee,j@j.test,Sep 20 2026,Clinic,"AL, USA",GA,BC',
      'K Co,Kim Lee,k@k.test,Sep 20 2026,Clinic,"Alabama, USA",GA,BC',
      'L Co,Kim Lee,l@l.test,Sep 20 2026,Clinic,AL USA,GA,BC',
      'M Co,Kim Lee,m@m.test,Sep 20 2026,Clinic,Mobile Alabama,AL,BC',
      'N Co,Kim Lee,n@n.test,Sep 20 2026,Clinic,Mobile al,GA,BC',
      'O Co,Kim Lee,o@o.test,Sep 20 2026,Clinic,"Mobile, AL",N/A,BC',
      'P Co,Kim Lee,p@p.test,Sep 20 2026,Clinic,AL,AL,BC',
      'Q Co,Kim Lee,q@q.test,Sep 20 2026,Clinic,"Mobile, AL, GA",GA,BC',
      'R Co,Kim Lee,r@r.test,Sep 20 2026,Clinic,"Mobile, AL","GA, USA",BC',
      'S Co,Kim Lee,s@s.test,Sep 20 2026,Clinic,"Mobile County, AL",AL,BC',
      'T Co,Kim Lee,t@t.test,Sep 20 2026,Clinic,Mobile,GA or AL,BC',
      'U Co,Kim Lee,u@u.test,Sep 20 2026,Clinic,Missouri City,"TX, USA",BC',
      'V Co,Kim Lee,v@v.test,Sep 20 2026,Clinic,"Mobile, AL 36602, Atlanta Georgia","GA, USA",BC',
    ].join('\n');
    const n = normalizeLeadCsv(rows, { kind: 'bid_sheet', minBidDate: '2026-09-01' });
    const out = parseCsv(n.csv);
    const at = out[0].indexOf('City + State');
    expect(out.slice(1).map((r) => r[at])).toEqual(['Mobile AL', '', 'Mobile, AL 36602', 'N.A., AL', 'NULL, AL', 'Santa Fe, NM', '', '', 'Mobile, AL, USA',
      '', '', '', 'Mobile Alabama, AL', '', 'Mobile, AL', 'AL', '', '', 'Mobile County, AL', 'Mobile', 'Missouri City, TX, USA', '']);
    expect(n.warnings).toContain('10 rows have a location and a State column that name different states; the city was left out.');
    const r = await planFromCsv([{ name: 'bids.csv', text: rows }], { now, signature: '', limit: 50 });
    const first = (to) => r.samples.find((s) => s.step === 'e1' && s.to === to).bodyText.split('\n\n').slice(0, 2);
    expect(first('a@a.test')).toEqual(["Kim, did y'all win this Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
    expect(first('b@b.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the SWPPP.']);
    expect(first('c@c.test')).toEqual(["Kim, did y'all win this Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
    expect(first('d@d.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the CBMPP.']);
    expect(first('e@e.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the CBMPP.']);
    expect(first('f@f.test')[0]).toBe("Kim, did y'all win this Clinic over in Santa Fe?");
    expect(first('g@g.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the SWPPP.']);
    expect(first('h@h.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the SWPPP.']);
    expect(first('i@i.test')).toEqual(["Kim, did y'all win this Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
    for (const to of ['j@j.test', 'k@k.test', 'l@l.test', 'n@n.test']) expect(first(to)).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the SWPPP.']);
    expect(first('m@m.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the CBMPP.']);
    expect(first('o@o.test')).toEqual(["Kim, did y'all win this Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
    expect(first('p@p.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the CBMPP.']);
    for (const to of ['q@q.test', 'r@r.test', 't@t.test', 'v@v.test']) expect(first(to)).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the SWPPP.']);
    expect(first('s@s.test')).toEqual(["Kim, did y'all win this Clinic?", 'You should have a bid from us on the CBMPP.']);
    expect(first('u@u.test')).toEqual(["Kim, did y'all win this Clinic over in Missouri City?", 'You should have a bid from us on the SWPPP.']);
  });
  it('flags every sample that uses wording not on the page: grouped Email 2/3 (the signature is on the page now)', async () => {
    const r = await planFromCsv([{ name: 'bids.csv', text: CSV }], { now });
    for (const s of r.samples) expect(s.flags).not.toContain('signature_not_on_page');
    const groupedFollowups = r.samples.filter((s) => s.step !== 'e1' && s.to === 'rodger@gc.test');
    expect(groupedFollowups.map((s) => s.step)).toEqual(['e2', 'e3']);
    for (const s of groupedFollowups) expect(s.flags).toContain('grouped_followup_wording_not_on_page');
    const singleFollowups = r.samples.filter((s) => s.step !== 'e1' && s.to === 'kim@gulf.test');
    for (const s of singleFollowups) expect(s.flags).not.toContain('grouped_followup_wording_not_on_page');
    expect(groupedFollowups[0].subject).toBe('Re: Your recent bids');
    const html = renderPreviewHtml(r);
    expect(html).toContain('Email 2/3 naming several projects: this wording is not on the page Derek saw.');
  });
  it('customer match by company name (Pipedrive reads only)', async () => {
    const isCustomerCompany = vi.fn(async (name) => (name === 'Gulf Builders' ? { reason: 'org_name' } : null));
    const r = await planFromCsv([{ name: 'bids.csv', text: CSV }], { now, isCustomerCompany });
    expect(r.counts.customers_matched).toBe(1);
    expect(r.samples.find((s) => s.to === 'kim@gulf.test' && s.step === 'e1').customer).toBe(true);
    // Customers only get Email 1, so no Email 2/3 sample for them.
    expect(r.samples.filter((s) => s.to === 'kim@gulf.test' && s.step !== 'e1')).toHaveLength(0);
  });
  it('script options', () => {
    expect(parseArgs(['--csv', 'a.csv', 'b.csv', '--limit=5', '--out=x.html'])).toMatchObject({ csv: ['a.csv', 'b.csv'], limit: 5, out: 'x.html', force: false });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
    expect(parseArgs(['--pilot=10']).pilot).toBe(10);
    const now = new Date('2026-11-03T15:00:00Z');
    const result = { samples: [
      { batchId: null, step: 'e1', sendAt: '2026-11-03T22:00:00Z', leads: [{ id: 'n1', bidDate: '2026-10-20' }, { id: 'n2', bidDate: '2026-10-01' }] },
      { batchId: 'b-open', step: 'e2', sendAt: '2026-11-03T22:00:00Z', leads: [{ id: 'o1', bidDate: '2026-10-25' }] },
      { batchId: null, step: 'e1', sendAt: '2026-11-12T13:00:00Z', leads: [{ id: 'future', bidDate: '2026-11-10' }] },
      { batchId: null, step: 'e1', sendAt: '2026-11-04T12:30:00Z', leads: [{ id: 'n3', bidDate: '2026-10-28' }] },
      { batchId: null, step: 'e1', sendAt: '2026-11-03T22:00:00Z', holds: ['recent_reply'], leads: [{ id: 'held', bidDate: '2026-10-30' }] },
      { batchId: null, step: 'e1', sendAt: '2026-11-03T22:00:00Z', leads: [{ id: 'n4', bidDate: '2026-09-15' }] },
    ] };
    // Due within a day, not held, newest bid first; a batch's leads all included.
    expect(pilotLeadIds(result, 2, now)).toEqual(['n3', 'n1', 'n2']);
  });
});
