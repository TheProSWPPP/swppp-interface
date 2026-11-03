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
    expect(grouped.bodyText.split('\n')[0]).toBe("Hey Rodger, did y'all win any of these? Wharton SWPPP, Fort Bend ISD Natatorium SWPPP, Zavala County Jail SWPPP. You should have SWPPP bids from us on each one. Let us know when you need us.");
    expect(grouped.leads).toHaveLength(4);
    expect(grouped.leads.filter((l) => !l.named)).toHaveLength(1);
    const single = r.samples.find((s) => s.step === 'e1' && s.to === 'kim@gulf.test');
    expect(single.subject).toBe('UTMB CLC Parking Lot SWPPP');
    expect(single.bodyText.split('\n')[0]).toBe("Hey Kim, did y'all win UTMB CLC Parking Lot SWPPP? You should have a bid from us on the SWPPP. Let us know when you need it.");
  });
  it('flags every sample that uses wording not on the page: grouped Email 2/3 and the signature', async () => {
    const r = await planFromCsv([{ name: 'bids.csv', text: CSV }], { now });
    for (const s of r.samples) expect(s.flags).toContain('signature_not_on_page');
    const groupedFollowups = r.samples.filter((s) => s.step !== 'e1' && s.to === 'rodger@gc.test');
    expect(groupedFollowups.map((s) => s.step)).toEqual(['e2', 'e3']);
    for (const s of groupedFollowups) expect(s.flags).toContain('grouped_followup_wording_not_on_page');
    const singleFollowups = r.samples.filter((s) => s.step !== 'e1' && s.to === 'kim@gulf.test');
    for (const s of singleFollowups) expect(s.flags).not.toContain('grouped_followup_wording_not_on_page');
    expect(groupedFollowups[0].subject).toBe('Re: Your recent bids');
    const noSig = await planFromCsv([{ name: 'bids.csv', text: CSV }], { now, signature: '' });
    expect(noSig.samples.every((s) => !s.flags.includes('signature_not_on_page'))).toBe(true);
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
    const result = { samples: [
      { batchId: null, step: 'e1', leads: [{ id: 'n1' }, { id: 'n2' }] },
      { batchId: 'b-open', step: 'e2', leads: [{ id: 'o1' }] },
      { batchId: null, step: 'e1', leads: [{ id: 'n3' }] },
      { batchId: null, step: 'e1', leads: [{ id: 'n4' }] },
    ] };
    expect(pilotLeadIds(result, 2)).toEqual(['n1', 'n2', 'n3']);
  });
});
