// State geo-term lookup — ported VERBATIM from the n8n SDR Automation workflow
// (workflow pcUKAkMkvoKQ4kPY, "State Geo Term Lookup" node, source: Derek's ST
// Abbreviations.xlsx, April 2026). Resolves a project's state from its address and maps
// it to the right environmental agency + stormwater-plan acronym, so the email merge
// fields {ENV} / {SWPPP} read correctly per state (TCEQ/SWPPP in TX, ADEM/CBMPP in
// AL, GA EPD/ES&PC Plan in GA, ...). Defaults to EPA / SWPPP / CPESC when no state is found.

const STATE_GEO_TERMS = {
  'Alabama': { env: 'ADEM', swppp: 'CBMPP', cert: 'QCI / QCP' },
  'Alaska': { env: 'ADEC', swppp: 'SWPPP', cert: 'CPESC' },
  'Arizona': { env: 'ADEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Arkansas': { env: 'ADEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'California': { env: 'CASQUA', swppp: 'SWPPP', cert: 'QSP' },
  'Colorado': { env: 'CDPHE', swppp: 'SWPPP', cert: 'CPESC' },
  'Connecticut': { env: 'CT DEEP', swppp: 'SWPPP', cert: 'CPESC' },
  'Delaware': { env: 'DNREC', swppp: 'SWPPP', cert: 'CPESC' },
  'Florida': { env: 'FDEP', swppp: 'SWPPP', cert: 'FSESCI' },
  'Georgia': { env: 'GA EPD', swppp: 'ES&PC Plan', cert: 'Level IB' },
  'Hawaii': { env: 'HI DOH', swppp: 'SWPPP', cert: 'CPESC' },
  'Idaho': { env: 'IDEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Illinois': { env: 'IL EPA', swppp: 'SWPPP', cert: 'CPESC' },
  'Indiana': { env: 'IDEM', swppp: 'SWPPP', cert: 'CPESC' },
  'Iowa': { env: 'IA DNR', swppp: 'SWPPP', cert: 'CPESC' },
  'Kansas': { env: 'KDHE', swppp: 'SWPPP', cert: 'CPESC' },
  'Kentucky': { env: 'KY DEP', swppp: 'SWPPP', cert: 'CPESC' },
  'Louisiana': { env: 'LDEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Maine': { env: 'MEDEP', swppp: 'SWPPP', cert: 'CPESC' },
  'Maryland': { env: 'MDE', swppp: 'SWPPP', cert: 'CPESC' },
  'Massachusetts': { env: 'MASS DEP', swppp: 'SWPPP', cert: 'CPESC' },
  'Michigan': { env: 'MI EGLE', swppp: 'SWPPP', cert: 'CPESC' },
  'Minnesota': { env: 'MPCA', swppp: 'SWPPP', cert: 'CPESC' },
  'Mississippi': { env: 'MS DEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Missouri': { env: 'MO DNR', swppp: 'SWPPP', cert: 'CPESC' },
  'Montana': { env: 'MT DEQ', swppp: 'SWPPP', cert: 'MT DEQ SWPPP CERTIFIED' },
  'Nebraska': { env: 'NDEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Nevada': { env: 'NDEP', swppp: 'SWPPP', cert: 'CPESC' },
  'New Hampshire': { env: 'NHDES', swppp: 'SWPPP', cert: 'CPESC' },
  'New Jersey': { env: 'NJ DEP', swppp: 'SWPPP', cert: 'CPESC' },
  'New Mexico': { env: 'NM EPA', swppp: 'SWPPP', cert: 'CPESC' },
  'New York': { env: 'NYSDEC (SPDES)', swppp: 'SWPPP', cert: 'QI' },
  'North Carolina': { env: 'NC DEQ', swppp: 'E&SC PLAN', cert: 'CPESC' },
  'North Dakota': { env: 'ND DEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Ohio': { env: 'OH EPA', swppp: 'SWPPP', cert: 'CPESC' },
  'Oklahoma': { env: 'ODEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Oregon': { env: 'OR DEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Pennsylvania': { env: 'PA DEP', swppp: 'SWPPP / E&S PLAN', cert: 'CPESC' },
  'Rhode Island': { env: 'RI DEM', swppp: 'SWPPP', cert: 'CPESC' },
  'South Carolina': { env: 'SC DES', swppp: 'SWPPP', cert: 'CEPSCI' },
  'South Dakota': { env: 'SD DANR', swppp: 'SWPPP', cert: 'CPESC' },
  'Tennessee': { env: 'TDEC', swppp: 'SWPPP', cert: 'CPESC' },
  'Texas': { env: 'TCEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Utah': { env: 'UT DEQ', swppp: 'SWPPP', cert: 'CPESC' },
  'Vermont': { env: 'VT DEC', swppp: 'SWPPP', cert: 'CPESC' },
  'Virginia': { env: 'VA DEQ / VSMP', swppp: 'SWPPP', cert: 'CPESC' },
  'Washington': { env: 'WA ECOLOGY', swppp: 'SWPPP', cert: 'CESCL' },
  'West Virginia': { env: 'WV DEP', swppp: 'SWPPP', cert: 'CPESC' },
  'Wisconsin': { env: 'WDNR', swppp: 'SWPPP', cert: 'CPESC' },
  'Wyoming': { env: 'WY DEQ', swppp: 'SWPPP', cert: 'CPESC' }
};

const STATE_ABBREV = {
  'AL': 'Alabama',
  'AK': 'Alaska',
  'AZ': 'Arizona',
  'AR': 'Arkansas',
  'CA': 'California',
  'CO': 'Colorado',
  'CT': 'Connecticut',
  'DE': 'Delaware',
  'FL': 'Florida',
  'GA': 'Georgia',
  'HI': 'Hawaii',
  'ID': 'Idaho',
  'IL': 'Illinois',
  'IN': 'Indiana',
  'IA': 'Iowa',
  'KS': 'Kansas',
  'KY': 'Kentucky',
  'LA': 'Louisiana',
  'ME': 'Maine',
  'MD': 'Maryland',
  'MA': 'Massachusetts',
  'MI': 'Michigan',
  'MN': 'Minnesota',
  'MS': 'Mississippi',
  'MO': 'Missouri',
  'MT': 'Montana',
  'NE': 'Nebraska',
  'NV': 'Nevada',
  'NH': 'New Hampshire',
  'NJ': 'New Jersey',
  'NM': 'New Mexico',
  'NY': 'New York',
  'NC': 'North Carolina',
  'ND': 'North Dakota',
  'OH': 'Ohio',
  'OK': 'Oklahoma',
  'OR': 'Oregon',
  'PA': 'Pennsylvania',
  'RI': 'Rhode Island',
  'SC': 'South Carolina',
  'SD': 'South Dakota',
  'TN': 'Tennessee',
  'TX': 'Texas',
  'UT': 'Utah',
  'VT': 'Vermont',
  'VA': 'Virginia',
  'WA': 'Washington',
  'WV': 'West Virginia',
  'WI': 'Wisconsin',
  'WY': 'Wyoming'
};

function extractState(address) {
  if (!address) return null;
  const cleaned = address.trim();
  // Pattern 1: "City, ST" or "City, ST 12345"
  const m1 = cleaned.match(/,\s*([A-Z]{2})(?:\s+\d{5})?$/i);
  if (m1) { const a = m1[1].toUpperCase(); if (STATE_ABBREV[a]) return STATE_ABBREV[a]; }
  // Pattern 2: Full address with state before zip
  const m2 = cleaned.match(/,\s*([A-Za-z\s]+?)\s+\d{5}/);
  if (m2) {
    const p = m2[1].trim();
    if (p.length === 2 && STATE_ABBREV[p.toUpperCase()]) return STATE_ABBREV[p.toUpperCase()];
    if (STATE_GEO_TERMS[p]) return p;
  }
  // Pattern 3: State abbreviation anywhere
  for (const [abbrev, fullName] of Object.entries(STATE_ABBREV)) {
    if (new RegExp(`\\b${abbrev}\\b`, 'i').test(cleaned)) return fullName;
  }
  // Pattern 4: Full state name
  for (const stateName of Object.keys(STATE_GEO_TERMS)) {
    if (cleaned.toLowerCase().includes(stateName.toLowerCase())) return stateName;
  }
  return null;
}

// Resolve {ENV} / {SWPPP} / cert for a project address. Always returns usable values.
export function resolveStateTerms(address) {
  const state = extractState(address);
  if (state && STATE_GEO_TERMS[state]) {
    return { state, env: STATE_GEO_TERMS[state].env, swppp: STATE_GEO_TERMS[state].swppp, cert: STATE_GEO_TERMS[state].cert };
  }
  return { state: null, env: "EPA", swppp: "SWPPP", cert: "CPESC" };
}

export { STATE_GEO_TERMS };
