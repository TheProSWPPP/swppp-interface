import { describe, it, expect } from 'vitest';
import { renderBidEmail, firstName, joinNames, replySubject, FLAG_GROUPED_FOLLOWUP, FLAG_SIGNATURE } from '../bidInviteCopy.js';

// The exact wording on the client page (ProSWPPP-Bid-Invites-and-LinkedIn.html, Part 1).
const PAGE = {
  e1Single: "Hey Rodger, did y'all win UTMB CLC Parking Lot SWPPP? You should have a bid from us on the SWPPP. Let us know when you need it.",
  e1Grouped: "Hey Rodger, did y'all win any of these? Zavala SWPPP, Fort Bend SWPPP, Wharton SWPPP. You should have SWPPP bids from us on each one. Let us know when you need us.",
  e2: 'Hey Rodger, checking back on UTMB CLC Parking Lot SWPPP. If it went your way, we can have the SWPPP ready before you mobilize.',
  e3: 'Hey Rodger, last note on UTMB CLC Parking Lot SWPPP. If you won it, happy to get the SWPPP going. If it went another way, no worries.',
};

describe('bid invite copy matches the page word for word', () => {
  it('Email 1, one project: subject is the short name', () => {
    const r = renderBidEmail({ step: 'e1', firstName: 'Rodger', names: ['UTMB CLC Parking Lot SWPPP'] });
    expect(r.subject).toBe('UTMB CLC Parking Lot SWPPP');
    expect(r.bodyText).toBe(PAGE.e1Single);
    expect(r.flags).toEqual([]);
  });
  it('Email 1, several projects: "Your recent bids"', () => {
    const r = renderBidEmail({ step: 'e1', firstName: 'Rodger', names: ['Zavala SWPPP', 'Fort Bend SWPPP', 'Wharton SWPPP'] });
    expect(r.subject).toBe('Your recent bids');
    expect(r.bodyText).toBe(PAGE.e1Grouped);
    expect(r.bodyText).not.toMatch(/[{}]/);
    expect(r.flags).toEqual([]);
  });
  it('Email 2 and 3 are replies in the thread (no subject of their own)', () => {
    const e2 = renderBidEmail({ step: 'e2', firstName: 'Rodger', names: ['UTMB CLC Parking Lot SWPPP'] });
    const e3 = renderBidEmail({ step: 'e3', firstName: 'Rodger', names: ['UTMB CLC Parking Lot SWPPP'] });
    expect(e2.subject).toBeNull();
    expect(e3.subject).toBeNull();
    expect(e2.bodyText).toBe(PAGE.e2);
    expect(e3.bodyText).toBe(PAGE.e3);
    expect(replySubject('UTMB CLC Parking Lot SWPPP')).toBe('Re: UTMB CLC Parking Lot SWPPP');
    expect(replySubject('Re: Your recent bids')).toBe('Re: Your recent bids');
  });
  it('no name: "Hey, did y\'all win ..."', () => {
    expect(renderBidEmail({ step: 'e1', firstName: null, names: ['Wharton SWPPP'] }).bodyText)
      .toBe("Hey, did y'all win Wharton SWPPP? You should have a bid from us on the SWPPP. Let us know when you need it.");
    expect(renderBidEmail({ step: 'e2', names: ['Wharton SWPPP'] }).bodyText.startsWith('Hey, checking back on Wharton SWPPP.')).toBe(true);
  });
  it('straight apostrophes, no em dashes, no placeholders anywhere', () => {
    for (const step of ['e1', 'e2', 'e3']) for (const names of [['A SWPPP'], ['A SWPPP', 'B SWPPP', 'C SWPPP']]) {
      const { bodyText } = renderBidEmail({ step, firstName: 'Katie', names });
      expect(bodyText).not.toMatch(/[‘’—–{}]/);
    }
  });
  it('flags wording that is not on the page: grouped Email 2/3 and the signature', () => {
    const grouped = renderBidEmail({ step: 'e2', firstName: 'Rodger', names: ['A SWPPP', 'B SWPPP', 'C SWPPP'] });
    expect(grouped.bodyText).toBe('Hey Rodger, checking back on A SWPPP, B SWPPP and C SWPPP. If it went your way, we can have the SWPPP ready before you mobilize.');
    expect(grouped.flags).toEqual([FLAG_GROUPED_FOLLOWUP]);
    expect(renderBidEmail({ step: 'e3', names: ['A SWPPP', 'B SWPPP'] }).bodyText).toContain('last note on A SWPPP and B SWPPP.');
    const signed = renderBidEmail({ step: 'e1', firstName: 'Rodger', names: ['UTMB CLC Parking Lot SWPPP'], signature: 'Regards,\nDerek' });
    expect(signed.bodyText).toBe(`${PAGE.e1Single}\n\nRegards,\nDerek`);
    expect(signed.flags).toEqual([FLAG_SIGNATURE]);
    expect(signed.bodyHtml).toBe(`<div>${PAGE.e1Single}<br><br>Regards,<br>Derek</div>`);
    expect(signed.bodyHtml).not.toMatch(/<img/i);
  });
  it('first names: proper-cased, blank or an address gives no name', () => {
    expect(firstName('rodger caffey')).toBe('Rodger');
    expect(firstName('RODGER CAFFEY')).toBe('Rodger');
    expect(firstName('Katie Caffey')).toBe('Katie');
    expect(firstName('McKenzie')).toBe('McKenzie');
    for (const v of [null, '', '  ', 'estimating@gc.test', '123']) expect(firstName(v)).toBeNull();
    // "Last, First", titles, placeholders and role words (QA).
    expect(firstName('Smith, John')).toBe('John');
    expect(firstName('CAFFEY, RODGER')).toBe('Rodger');
    expect(firstName('Dr. Jane Doe')).toBe('Jane');
    expect(firstName('Mr John Smith')).toBe('John');
    expect(firstName("Mary-Kate O'Neil")).toBe('Mary-Kate');
    expect(firstName('Li Na')).toBe('Li');
    expect(firstName('Smith, John, Jr.')).toBe('John');
    expect(firstName('John Smith Jr.')).toBe('John');
    expect(firstName('n.a.')).toBeNull();
    for (const v of ['N/A', 'NA', 'TBD', 'tba', 'Estimating Department', 'Estimating', 'Bids Team', 'Preconstruction', 'Office', 'J.', 'Dr.'])
      expect(firstName(v)).toBeNull();
    expect(renderBidEmail({ step: 'e1', firstName: firstName('Smith, John'), names: ['A SWPPP'] }).bodyText.startsWith('Hey John, did')).toBe(true);
    expect(renderBidEmail({ step: 'e1', firstName: firstName('Estimating Department'), names: ['A SWPPP'] }).bodyText.startsWith("Hey, did y'all win")).toBe(true);
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
  it('escapes HTML in the HTML part', () => {
    expect(renderBidEmail({ step: 'e1', firstName: 'Al', names: ['A&B <Plant> SWPPP'] }).bodyHtml).toContain('A&amp;B &lt;Plant&gt; SWPPP');
  });
});
