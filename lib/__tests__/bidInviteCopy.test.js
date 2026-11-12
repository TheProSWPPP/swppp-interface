import { describe, it, expect } from 'vitest';
import { renderBidEmail, firstName, joinNames, replySubject, projectPlace, FLAG_GROUPED_FOLLOWUP, FLAG_MORE_PROJECTS } from '../bidInviteCopy.js';

// The wording on the client page (inboundonsteroids.com/shared/proswppp-plan-37386b43). Email 1 for
// one project is Derek's own rewrite there (2026-11-05); the others follow its shape.
const P = (...lines) => lines.join('\n\n');
const PAGE = {
  e1Single: P("Rodger, did y'all win this UTMB CLC Parking Lot over in Galveston?", 'You should have a bid from us on the SWPPP.',
    'If everything looks good on it, just let us know how quick you need it.', 'We appreciate it.'),
  e1Grouped: P("Rodger, did y'all win any of these?", 'Zavala, Fort Bend, Wharton.', 'You should have a bid from us on each one.',
    'If everything looks good on them, just let us know how quick you need them.', 'We appreciate it.'),
  e2: P('Rodger, checking back on this UTMB CLC Parking Lot over in Galveston.', 'If it went your way, we can have the SWPPP ready before you mobilize.'),
  e3: P('Rodger, last one on this UTMB CLC Parking Lot.', "If you won it, let's get the SWPPP going. If not, we'll get 'em on the next one."),
};
const ONE = { firstName: 'Rodger', names: ['UTMB CLC Parking Lot SWPPP'], addresses: ['Galveston, TX'] };

describe('bid invite copy matches the page word for word', () => {
  it('Email 1, one project: subject is the short name, the body names the job and its city', () => {
    const r = renderBidEmail({ step: 'e1', ...ONE });
    expect(r.subject).toBe('UTMB CLC Parking Lot SWPPP');
    expect(r.bodyText).toBe(PAGE.e1Single);
    expect(r.flags).toEqual([]);
  });
  it('Email 1, several projects: "Your recent bids", no city', () => {
    const r = renderBidEmail({ step: 'e1', firstName: 'Rodger', names: ['Zavala SWPPP', 'Fort Bend SWPPP', 'Wharton SWPPP'], addresses: ['Crystal City, TX', 'Sugar Land, TX', 'Wharton, TX'] });
    expect(r.subject).toBe('Your recent bids');
    expect(r.bodyText).toBe(PAGE.e1Grouped);
    expect(r.bodyText).not.toMatch(/[{}]/);
    expect(r.flags).toEqual([]);
  });
  it('Email 2 and 3 are replies in the thread (no subject of their own)', () => {
    const e2 = renderBidEmail({ step: 'e2', ...ONE });
    const e3 = renderBidEmail({ step: 'e3', ...ONE });
    expect(e2.subject).toBeNull();
    expect(e3.subject).toBeNull();
    expect(e2.bodyText).toBe(PAGE.e2);
    expect(e3.bodyText).toBe(PAGE.e3);
    expect(replySubject('UTMB CLC Parking Lot SWPPP')).toBe('Re: UTMB CLC Parking Lot SWPPP');
    expect(replySubject('Re: Your recent bids')).toBe('Re: Your recent bids');
  });
  it('no name: the sentence starts with a capital; no address: no city and plain "SWPPP"', () => {
    expect(renderBidEmail({ step: 'e1', firstName: null, names: ['Wharton SWPPP'] }).bodyText.split('\n\n').slice(0, 2))
      .toEqual(["Did y'all win this Wharton?", 'You should have a bid from us on the SWPPP.']);
    expect(renderBidEmail({ step: 'e2', names: ['Wharton SWPPP'] }).bodyText.startsWith('Checking back on this Wharton.')).toBe(true);
    expect(renderBidEmail({ step: 'e3', names: ['Wharton SWPPP'] }).bodyText.startsWith('Last one on this Wharton.')).toBe(true);
    expect(renderBidEmail({ step: 'e1', names: ['A SWPPP', 'B SWPPP'] }).bodyText.startsWith("Did y'all win any of these?")).toBe(true);
  });
  it("the state's own term: in the email and the subject; mixed states in one email fall back to SWPPP", () => {
    const al = renderBidEmail({ step: 'e1', firstName: 'Kim', names: ['Mobile Clinic SWPPP'], addresses: ['Mobile, AL'] });
    expect(al.subject).toBe('Mobile Clinic CBMPP');
    expect(al.bodyText.split('\n\n').slice(0, 2)).toEqual(["Kim, did y'all win this Mobile Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
    expect(renderBidEmail({ step: 'e2', firstName: 'Kim', names: ['Macon Depot SWPPP'], addresses: ['Macon, GA'] }).bodyText).toContain('we can have the ES&PC Plan ready before you mobilize.');
    expect(renderBidEmail({ step: 'e3', firstName: 'Kim', names: ['Mobile Clinic SWPPP'], addresses: ['Mobile, AL'] }).bodyText).toContain("let's get the CBMPP going.");
    const same = renderBidEmail({ step: 'e2', firstName: 'Kim', names: ['A SWPPP', 'B SWPPP'], addresses: ['Mobile, AL', 'Dothan, AL'] });
    expect(same.bodyText).toContain('we can have the CBMPP ready');
    const mixed = renderBidEmail({ step: 'e2', firstName: 'Kim', names: ['A SWPPP', 'B SWPPP'], addresses: ['Mobile, AL', 'Houston, TX'] });
    expect(mixed.bodyText).toContain('we can have the SWPPP ready');
    // Projects the email only counts ("and 2 more") have no address here, so the term stays plain.
    expect(renderBidEmail({ step: 'e2', names: ['A SWPPP'], addresses: ['Mobile, AL'], more: 2 }).bodyText).toContain('we can have the SWPPP ready');
  });
  it('project address -> city, state, term; anything unclear gives no city and SWPPP', () => {
    expect(projectPlace('Wagoner, OK')).toEqual({ city: 'Wagoner', state: 'OK', term: 'SWPPP' });
    expect(projectPlace('TUSCALOOSA, AL')).toEqual({ city: 'Tuscaloosa', state: 'AL', term: 'CBMPP' });
    expect(projectPlace('123 Main St, fort worth, TX 76102')).toMatchObject({ city: 'Fort Worth', state: 'TX' });
    expect(projectPlace('Atlanta, Georgia, USA')).toMatchObject({ city: 'Atlanta', state: 'GA', term: 'ES&PC Plan' });
    expect(projectPlace('Houston TX')).toMatchObject({ city: 'Houston', state: 'TX' });
    expect(projectPlace('St. Louis, MO')).toMatchObject({ city: 'St. Louis', state: 'MO' });
    expect(projectPlace("Coeur d'Alene, ID")).toMatchObject({ city: "Coeur d'Alene", state: 'ID' });
    expect(projectPlace('AL')).toMatchObject({ city: null, state: 'AL', term: 'CBMPP' });
    expect(projectPlace('TBD, TX')).toMatchObject({ city: null, state: 'TX' });
    expect(projectPlace('Hwy 59 MM 12, TX')).toMatchObject({ city: null, state: 'TX' });
    for (const v of [null, '', '   ', 'Houston', 'somewhere in or near the port', 'Toronto, Ontario', 'Port of Me', 'A, B'])
      expect(projectPlace(v)).toEqual({ city: null, state: null, term: 'SWPPP' });
  });
  it('straight apostrophes, no em dashes, no placeholders anywhere', () => {
    for (const step of ['e1', 'e2', 'e3']) for (const names of [['A SWPPP'], ['A SWPPP', 'B SWPPP', 'C SWPPP']]) {
      const { bodyText } = renderBidEmail({ step, firstName: 'Katie', names, addresses: ['Mobile, AL'] });
      expect(bodyText).not.toMatch(/[‘’—–{}]/);
    }
  });
  it('flags wording that is not on the page: grouped Email 2/3; the signature closes the email unflagged', () => {
    const grouped = renderBidEmail({ step: 'e2', firstName: 'Rodger', names: ['A SWPPP', 'B SWPPP', 'C SWPPP'] });
    expect(grouped.bodyText).toBe(P('Rodger, checking back on A, B and C.', 'If it went your way, we can have the SWPPP ready before you mobilize.'));
    expect(grouped.flags).toEqual([FLAG_GROUPED_FOLLOWUP]);
    expect(renderBidEmail({ step: 'e3', names: ['A SWPPP', 'B SWPPP'] }).bodyText).toContain('Last one on A and B.');
    const signed = renderBidEmail({ step: 'e1', ...ONE, signature: 'Regards,\r\nDerek' });
    expect(signed.bodyText).toBe(`${PAGE.e1Single}\n\nRegards,\nDerek`);
    expect(signed.flags).toEqual([]);
    expect(signed.bodyHtml).toBe(`<div>${PAGE.e1Single.replace(/'/g, "'").replace(/\n/g, '<br>')}<br><br>Regards,<br>Derek</div>`);
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
    expect(renderBidEmail({ step: 'e1', firstName: firstName('Smith, John'), names: ['A SWPPP'] }).bodyText.startsWith("John, did y'all win this A?")).toBe(true);
    expect(renderBidEmail({ step: 'e1', firstName: firstName('Estimating Department'), names: ['A SWPPP'] }).bodyText.startsWith("Did y'all win this A?")).toBe(true);
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
  it('escapes HTML in the HTML part', () => {
    expect(renderBidEmail({ step: 'e1', firstName: 'Al', names: ['A&B <Plant> SWPPP'] }).bodyHtml).toContain('A&amp;B &lt;Plant&gt;');
  });
});

describe('more than 3 projects for one contact (go-live review 2026-11-03)', () => {
  it('Email 1 names 3 and adds "and N more" before the period, flagged as not on the page', () => {
    const r = renderBidEmail({ step: 'e1', firstName: 'Rodger', names: ['Zavala SWPPP', 'Fort Bend SWPPP', 'Wharton SWPPP'], more: 2 });
    expect(r.subject).toBe('Your recent bids');
    expect(r.bodyText.split('\n\n').slice(0, 3)).toEqual(["Rodger, did y'all win any of these?", 'Zavala, Fort Bend, Wharton and 2 more.', 'You should have a bid from us on each one.']);
    expect(r.flags).toEqual([FLAG_MORE_PROJECTS]);
    expect(renderBidEmail({ step: 'e1', names: ['A SWPPP', 'B SWPPP', 'C SWPPP'] }).flags).toEqual([]);
  });
  it('Emails 2 and 3 count them too, and say so in the flags', () => {
    const r = renderBidEmail({ step: 'e2', firstName: 'Rodger', names: ['A SWPPP', 'B SWPPP', 'C SWPPP'], more: 1 });
    expect(r.bodyText).toBe(P('Rodger, checking back on A, B, C and 1 more.', 'If it went your way, we can have the SWPPP ready before you mobilize.'));
    expect(r.flags).toEqual([FLAG_MORE_PROJECTS, FLAG_GROUPED_FOLLOWUP]);
    expect(joinNames(['A', 'B'], 0)).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'], 3)).toBe('A, B, C and 3 more');
  });
});
