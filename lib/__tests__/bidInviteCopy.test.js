import { describe, it, expect } from 'vitest';
import { renderBidEmail, firstName, joinNames, replySubject, projectPlace, FLAG_GROUPED_FOLLOWUP, FLAG_MORE_PROJECTS } from '../bidInviteCopy.js';
import { parseLocation, titlePlace } from '../bidInvitePlan.js';

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
    const al = renderBidEmail({ step: 'e1', firstName: 'Kim', names: ['Bay Clinic SWPPP'], addresses: ['Mobile, AL'] });
    expect(al.subject).toBe('Bay Clinic CBMPP');
    expect(al.bodyText.split('\n\n').slice(0, 2)).toEqual(["Kim, did y'all win this Bay Clinic over in Mobile?", 'You should have a bid from us on the CBMPP.']);
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
    for (const v of ['N.A., AL', 'n/a, AL', 'NULL, AL', 'None, AL', 'Not Available, AL']) expect(projectPlace(v)).toMatchObject({ city: null, state: 'AL', term: 'CBMPP' });
    expect(projectPlace('Hwy 59 MM 12, TX')).toMatchObject({ city: null, state: 'TX' });
    for (const v of [null, '', '   ', 'Houston', 'somewhere in or near the port', 'Toronto, Ontario', 'Port of Me', 'A, B'])
      expect(projectPlace(v)).toEqual({ city: null, state: null, term: 'SWPPP' });
  });
  it('the place is said once: a name that ends in the city loses it, a name that has it elsewhere gets no "over in"', () => {
    const first = (names, addresses, step = 'e1') => renderBidEmail({ step, firstName: 'Kim', names, addresses }).bodyText.split('\n\n')[0];
    expect(first(['7-Eleven Florence SC SWPPP'], ['Florence, SC'])).toBe("Kim, did y'all win this 7-Eleven over in Florence?");
    expect(first(['Shell MOB Building Airline Drive - Houston SWPPP'], ['Houston, TX'])).toBe("Kim, did y'all win this Shell MOB Building Airline Drive over in Houston?");
    expect(first(['Taco Bell St Cloud Florida SWPPP'], ['St. Cloud, FL'])).toBe("Kim, did y'all win this Taco Bell over in St. Cloud?");
    expect(first(['7-Eleven Florence SC SWPPP'], ['Florence, SC'], 'e2')).toBe('Kim, checking back on this 7-Eleven over in Florence.');
    // The third email names no city, so the name stays whole.
    expect(first(['7-Eleven Florence SC SWPPP'], ['Florence, SC'], 'e3')).toBe('Kim, last one on this 7-Eleven Florence SC.');
    // The city is in the name already: no "over in".
    expect(first(['Mobile Clinic SWPPP'], ['Mobile, AL'])).toBe("Kim, did y'all win this Mobile Clinic?");
    expect(first(['City of Ocala Fire Station SWPPP'], ['Ocala, FL'])).toBe("Kim, did y'all win this City of Ocala Fire Station?");
    // A different state after the city is not this place; nothing left after the cut keeps the name.
    expect(first(['Florence GA Depot SWPPP'], ['Florence, SC'])).toBe("Kim, did y'all win this Florence GA Depot?");
    expect(first(['Florence SC SWPPP'], ['Florence, SC'])).toBe("Kim, did y'all win this Florence SC?");
    // Part of a longer word is not the city.
    expect(first(['Mobilette Depot SWPPP'], ['Mobile, AL'])).toBe("Kim, did y'all win this Mobilette Depot over in Mobile?");
    // The city is still in the name after the cut: said once, in the name.
    expect(first(['Maple Grove Storage Maple Grove MN SWPPP'], ['Maple Grove, MN'])).toBe("Kim, did y'all win this Maple Grove Storage?");
    // A long name cut off inside the city loses the cut-off piece; a short name is left alone.
    expect(first(['Ground Up Whitewater Express Carwash- La SWPPP'], ['La Porte, TX'])).toBe("Kim, did y'all win this Ground Up Whitewater Express Carwash over in La Porte?");
    expect(first(['Gunn Highway Shell Building Annex Odes SWPPP'], ['Odessa, FL'])).toBe("Kim, did y'all win this Gunn Highway Shell Building Annex over in Odessa?");
    expect(first(['Burger Den SWPPP'], ['Denver, CO'])).toBe("Kim, did y'all win this Burger Den over in Denver?");
    // The subject keeps the full name.
    expect(renderBidEmail({ step: 'e1', names: ['Raising Canes Dallas GA SWPPP'], addresses: ['Dallas, GA'] }).subject).toBe('Raising Canes Dallas GA ES&PC Plan');
  });
  it('a place at the end of a project title: strict, city only after a clear mark', () => {
    expect(titlePlace('7-Eleven - Florence, SC')).toEqual({ state: 'SC', city: 'Florence' });
    expect(titlePlace('Gunn Highway Shell Building (Odessa, FL)')).toEqual({ state: 'FL', city: 'Odessa' });
    expect(titlePlace('Shell MOB Building (Airline Drive) - Houston, Texas')).toEqual({ state: 'TX', city: 'Houston' });
    expect(titlePlace('Tractor Supply #1680- Snyder, TX')).toEqual({ state: 'TX', city: 'Snyder' });
    expect(titlePlace('Behavioral Health Facility / Malaga, WA 98828')).toEqual({ state: 'WA', city: 'Malaga' });
    expect(titlePlace('Taco Bell | Port St. Lucie, FL SWPPP')).toEqual({ state: 'FL', city: 'Port St. Lucie' });
    expect(titlePlace('Publix: Fuquay-Varina, NC')).toEqual({ state: 'NC', city: 'Fuquay-Varina' });
    expect(titlePlace('AutoZone FL10609- St .Johns, FL')).toEqual({ state: 'FL', city: 'St. Johns' });
    // No mark shows where the city starts: the state only.
    for (const t of ['Coolwood Playground Houston, TX', 'Walmart #807.1010 North Richland Hills, TX', 'CVS-Wendell, NC'])
      expect(titlePlace(t)).toMatchObject({ city: null });
    expect(titlePlace('Coolwood Playground Houston, TX').state).toBe('TX');
    // An abbreviation, a state as the city, an area: the state only.
    expect(titlePlace('Depot - FTW, TX')).toEqual({ state: 'TX', city: null });
    expect(titlePlace('7 Brew Coffee - Washington, NC')).toEqual({ state: 'NC', city: null });
    // Not a place at the end, a lower case code, or no comma: nothing.
    for (const t of [null, '', 'City of Bradenton | Love Park', 'Domain 9.5 (100% CDs)', 'Florence, SC - Phase 2', 'Clinic - Florence, sc', 'Clinic Florence SC',
      'Starbucks Sunset Blvd, LA', 'Tower - Phase 2, CO', 'Office - Bldg C, MD', 'Depot - Lot 4, IN', 'Clinic, PE', 'School - Addition, TX'])
      expect(titlePlace(t)).toBeNull();
  });
  it('one location reader for the import and the email: the state only from the end, a maybe is never used', () => {
    expect(parseLocation('Mobile, AL 36602, USA')).toMatchObject({ state: 'AL', cityPart: 'Mobile', sure: true, clash: false, bare: false });
    expect(parseLocation('Houston TX')).toMatchObject({ state: 'TX', cityPart: 'Houston', sure: true });
    for (const v of ['AL', 'al', 'AL, USA', 'AL USA', 'Alabama, USA', 'Alabama, United States of America', 'AL 36602'])
      expect(parseLocation(v)).toEqual({ state: 'AL', cityPart: null, sure: true, clash: false, bare: true });
    for (const v of ['Mobile Alabama', 'Mobile al', 'Mobile Al', 'Fort Worth ALABAMA 36602 USA'])
      expect(parseLocation(v)).toMatchObject({ state: 'AL', cityPart: null, sure: false, bare: false });
    expect(parseLocation('Santa Fe New Mexico')).toMatchObject({ state: 'NM', sure: false });
    expect(parseLocation('Mount Washington')).toMatchObject({ state: 'WA', sure: false });
    for (const v of [null, '', 'USA', 'Santa Fe', 'St. Louis', 'Kansas City', 'Toronto, Ontario', 'Mobile, USA', 'Columbus'])
      expect(parseLocation(v)).toMatchObject({ state: null, clash: false });
    // Two different states in one location: neither is used.
    for (const v of ['Mobile, AL, GA', 'Mobile AL, GA', 'GA AL', 'AL, GA', 'Mobile Alabama, GA', 'Alabama, GA, USA', 'Mount Washington, KY',
      'Mobile, AL 36602, Atlanta Georgia, GA, USA', 'Mobile, AL 36602, GA', 'Mobile AL 36602-1234, Atlanta, GA', 'AL 36602 GA'])
      expect(parseLocation(v)).toEqual({ state: null, cityPart: null, sure: false, clash: true, bare: false });
    // Street lines and ordinary words are not a second state.
    for (const [v, city] of [['123 4th St NE, Albuquerque, NM', 'Albuquerque'], ['100 Oak Ct, Houston, TX', 'Houston'], ['Missouri City, TX', 'Missouri City'],
      ['Kansas City, MO', 'Kansas City'], ['LA PORTE, TX', 'La Porte'], ['De Soto, TX', 'De Soto'], ['Mt Pleasant, TX', 'Mt Pleasant']])
      expect(projectPlace(v).city).toBe(city);
    // The email never uses a maybe or a clash, and never prints a state, a country, a county or a street as the city.
    for (const v of ['Mobile Alabama', 'Mobile al', 'Mount Washington', 'Mobile, AL, GA', 'GA AL']) expect(projectPlace(v)).toEqual({ city: null, state: null, term: 'SWPPP' });
    for (const v of ['AL USA, AL', 'Mobile AL, AL', 'Mobile Alabama, AL', 'Alabama, AL', 'USA, AL', 'United States, AL', 'Mobile County, AL', 'Orleans Parish, AL',
      'Greater Mobile Area, AL', 'Main Street, AL', 'Downtown, AL', 'Various Locations, AL'])
      expect(projectPlace(v)).toEqual({ city: null, state: 'AL', term: 'CBMPP' });
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
