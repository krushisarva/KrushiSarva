/**
 * PIN code helpers — pure, shared by both apps.
 *
 * The backend returns India Post's post-office list for a pincode
 * (GET /location/pincode/:pin). India Post's names are not the names our
 * pickers use, so this module maps them onto shared/constants:
 *
 *   "Raigarh(MH)"         → Raigad            (district alias)
 *   "Osmanabad"           → Dharashiv         (renamed district)
 *   "Ahmed Nagar"         → Ahmednagar        (spacing)
 *   "Buldana" / "Bid"     → Buldhana / Beed   (spelling, via a consonant key)
 *   "Daman & Diu"         → Dadra and Nagar Haveli and Daman and Diu
 *   Leh under "Jammu & Kashmir" → Ladakh      (district decides the state)
 *
 * A name that cannot be mapped is kept as India Post wrote it, flagged as not
 * canonical, so free-text fields can still use it and pickers can skip it.
 *
 * One pincode usually covers many villages, and can cover several districts or
 * even states. summarisePincode() reports only what is common to all of them;
 * the user picks a village to settle the rest.
 */
import { INDIA_DISTRICTS, INDIA_STATES_LIST, STATE_GPS_MAP } from '../constants/indiaLocations';
import { getTalukas } from '../constants/locations';
import { PINCODE_RE, isValidPincode } from './validators';

// One rule for the whole client: six digits, never starting with 0.
export { isValidPincode };
export const STRICT_PINCODE_RE = PINCODE_RE;

export const PINCODE_LENGTH = 6;
// For a PIN TextInput's maxLength. TextInput truncates BEFORE onChangeText, so
// a limit of 6 turns a pasted "413 102" into "41310"; sanitizePincode caps the
// stored value at six digits instead.
export const PINCODE_INPUT_MAX_LENGTH = 16;

// Zero code points of the digit sets an Indian keyboard or a pasted SMS can
// produce: Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu,
// Kannada, Malayalam, and full-width.
const DIGIT_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0xff10];

function toAsciiDigit(ch) {
  const c = ch.codePointAt(0);
  if (c >= 48 && c <= 57) return ch;
  for (const zero of DIGIT_ZEROS) {
    if (c >= zero && c <= zero + 9) return String(c - zero);
  }
  return '';
}

/**
 * What a PIN input should hold: digits only (any Indian script → ASCII),
 * at most six. "PIN: ४१३ १०२" → "413102".
 */
export function sanitizePincode(value) {
  if (value == null) return '';
  let out = '';
  for (const ch of String(value)) {
    out += toAsciiDigit(ch);
    if (out.length === PINCODE_LENGTH) break;
  }
  return out;
}

/**
 * Where a partially typed value stands, without a network call:
 * 'empty' | 'incomplete' | 'invalid' | 'complete'.
 */
export function pincodeInputState(value) {
  const pin = sanitizePincode(value);
  if (!pin) return 'empty';
  if (pin[0] === '0') return 'invalid';
  if (pin.length < PINCODE_LENGTH) return 'incomplete';
  return 'complete';
}

// ── Name matching ────────────────────────────────────────────────────────────

/** Letters only, lower-case, "&" read as "and", "(MH)"-style tags dropped. */
function nameKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Consonant skeleton for transliteration drift: Buldana/Buldhana,
 * Gondiya/Gondia, Bid/Beed, Kancheepuram/Kanchipuram. Only ever trusted when
 * exactly one candidate shares it.
 */
function skeletonKey(value) {
  return nameKey(value)
    .replace(/w/g, 'v')
    .replace(/[aeiouhy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

const STATE_EXTRA_ALIASES = {
  'Andaman & Nicobar': 'Andaman and Nicobar Islands',
  'Andaman and Nicobar': 'Andaman and Nicobar Islands',
  'Dadra & Nagar Haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'Daman & Diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'Dadra and Nagar Haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  'Daman and Diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'New Delhi': 'Delhi',
  'Chattisgarh': 'Chhattisgarh',
};

const STATE_BY_KEY = (() => {
  const m = new Map();
  for (const s of INDIA_STATES_LIST) m.set(nameKey(s), s);
  for (const [alias, s] of Object.entries(STATE_GPS_MAP)) m.set(nameKey(alias), s);
  for (const [alias, s] of Object.entries(STATE_EXTRA_ALIASES)) m.set(nameKey(alias), s);
  return m;
})();

// India Post names that no spelling rule reaches: renames, and districts filed
// under a different name. Keyed by canonical state, then by nameKey().
const DISTRICT_ALIASES = {
  'Maharashtra': {
    raigarh: 'Raigad',
    osmanabad: 'Dharashiv',
    ahilyanagar: 'Ahmednagar',
    chhatrapatisambhajinagar: 'Aurangabad',
  },
  'Haryana': { gurgaon: 'Gurugram', mewat: 'Nuh' },
  'Puducherry': { pondicherry: 'Puducherry' },
  'Karnataka': { bangalore: 'Bengaluru Urban', bangalorerural: 'Bengaluru Rural', mysore: 'Mysuru', belgaum: 'Belagavi', gulbarga: 'Kalaburagi', shimoga: 'Shivamogga', tumkur: 'Tumakuru', bellary: 'Ballari', bijapur: 'Vijayapura', chikmagalur: 'Chikkamagaluru' },
  'Uttar Pradesh': { allahabad: 'Prayagraj', faizabad: 'Ayodhya' },
  'Andhra Pradesh': { cuddapah: 'YSR Kadapa', kadapa: 'YSR Kadapa', anantapur: 'Ananthapuramu', nellore: 'Nellore' },
};

function districtsOf(state) {
  return INDIA_DISTRICTS[state] || [];
}

/**
 * The district as it appears in INDIA_DISTRICTS[state], or null.
 * @param {string} state   canonical state
 * @param {string} raw     India Post district
 * @param {{fuzzy?: boolean}} [opts]  allow prefix / consonant-key matches
 */
export function matchDistrict(state, raw, { fuzzy = true } = {}) {
  const list = districtsOf(state);
  const key = nameKey(raw);
  if (!list.length || !key) return null;

  const alias = DISTRICT_ALIASES[state]?.[key];
  if (alias && list.includes(alias)) return alias;

  const exact = list.find((d) => nameKey(d) === key);
  if (exact) return exact;
  if (!fuzzy) return null;

  // "Kamrup Metro" → "Kamrup Metropolitan"; "Mumbai" matches two, so nothing.
  const prefixed = list.filter((d) => nameKey(d).startsWith(key));
  if (prefixed.length === 1) return prefixed[0];

  const skel = skeletonKey(raw);
  if (skel.length < 2) return null;
  const similar = list.filter((d) => skeletonKey(d) === skel);
  return similar.length === 1 ? similar[0] : null;
}

/** Canonical state for India Post's state name, or null. */
export function matchState(raw) {
  return STATE_BY_KEY.get(nameKey(raw)) || null;
}

/**
 * Canonical state + district for one post office. The district wins when
 * India Post files it under a state it no longer belongs to (Leh and Kargil
 * are still "Jammu & Kashmir" there).
 * @returns {{state: string, stateCanonical: boolean, district: string, districtCanonical: boolean}}
 */
export function resolveStateDistrict(rawState, rawDistrict) {
  const state = matchState(rawState);
  if (state) {
    const district = matchDistrict(state, rawDistrict);
    if (district) return { state, stateCanonical: true, district, districtCanonical: true };
  }

  // Exact names only when searching every state — a fuzzy hit across 780
  // districts is not evidence of anything.
  const homes = [];
  for (const s of INDIA_STATES_LIST) {
    const d = matchDistrict(s, rawDistrict, { fuzzy: false });
    if (d) homes.push({ state: s, district: d });
  }
  if (homes.length === 1) {
    return { ...homes[0], stateCanonical: true, districtCanonical: true };
  }

  return {
    state: state || tidy(rawState),
    stateCanonical: Boolean(state),
    district: tidy(rawDistrict),
    districtCanonical: false,
  };
}

// India Post's "(MH)"-style disambiguation tags mean nothing in a text field.
function tidy(value) {
  return String(value ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The taluka as listed under `district` (Maharashtra only), or null. */
export function matchTaluka(state, district, rawBlock) {
  if (state !== 'Maharashtra' || !rawBlock) return null;
  const list = getTalukas(district);
  const key = nameKey(rawBlock);
  if (!list.length || !key) return null;
  const exact = list.find((t) => nameKey(t) === key);
  if (exact) return exact;
  const skel = skeletonKey(rawBlock);
  if (skel.length < 2) return null;
  const similar = list.filter((t) => skeletonKey(t) === skel);
  return similar.length === 1 ? similar[0] : null;
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Locality
 * @property {string}  key                unique within the pincode
 * @property {string}  name               post office / village name
 * @property {string}  label              what a picker shows
 * @property {?string} taluka
 * @property {boolean} talukaCanonical
 * @property {string}  district
 * @property {boolean} districtCanonical
 * @property {string}  state
 * @property {boolean} stateCanonical
 * @property {boolean} delivery
 */

/**
 * India Post still files some offices under the district a new one was carved
 * from — every Palghar office says "Thane". When the block is not a taluka of
 * the stated district but is, by exact name, a taluka of exactly one other
 * district in the state, that district is the real one. Names shared by two
 * districts (Khed, Karjat, Malegaon…) never move anything.
 */
function movedDistrict(state, district, rawBlock) {
  if (state !== 'Maharashtra' || !rawBlock) return null;
  const key = nameKey(rawBlock);
  const homes = districtsOf(state).filter((d) => d !== district && getTalukas(d).some((t) => nameKey(t) === key));
  return homes.length === 1 ? homes[0] : null;
}

function toLocality(office) {
  const sd = resolveStateDistrict(office.state, office.district);
  let canonicalTaluka = sd.districtCanonical ? matchTaluka(sd.state, sd.district, office.block) : null;
  if (sd.districtCanonical && !canonicalTaluka) {
    const moved = movedDistrict(sd.state, sd.district, office.block);
    if (moved) {
      sd.district = moved;
      canonicalTaluka = matchTaluka(sd.state, moved, office.block);
    }
  }
  const taluka = canonicalTaluka || (office.block ? tidy(office.block) : null);
  return {
    name: office.name,
    taluka: taluka || null,
    talukaCanonical: Boolean(canonicalTaluka),
    ...sd,
    delivery: Boolean(office.delivery),
  };
}

function only(values) {
  const set = new Set(values.filter(Boolean));
  return set.size === 1 ? [...set][0] : null;
}

/**
 * Condense a lookup result into what a form can use.
 *
 * `state`, `district` and `taluka` are set only when every locality agrees;
 * `village` only when there is exactly one locality. `city` is the best single
 * town name for an address: the village if there is one, else the taluka, else
 * the district.
 *
 * @param {{pincode: string, found: boolean, postOffices: object[]}} result
 */
export function summarisePincode(result) {
  const offices = Array.isArray(result?.postOffices) ? result.postOffices : [];
  const pincode = result?.pincode || '';
  const raw = offices.filter((o) => o && o.name && o.state && o.district).map(toLocality);

  // Same village listed under two blocks reads as a duplicate in a picker;
  // disambiguate the label only where names collide.
  const nameCount = new Map();
  for (const l of raw) nameCount.set(l.name.toLowerCase(), (nameCount.get(l.name.toLowerCase()) || 0) + 1);
  const seen = new Set();
  const localities = [];
  for (const l of raw) {
    const clash = nameCount.get(l.name.toLowerCase()) > 1;
    let label = clash ? [l.name, l.taluka || l.district].filter(Boolean).join(', ') : l.name;
    while (seen.has(label.toLowerCase())) label = `${label} (${l.district})`;
    seen.add(label.toLowerCase());
    localities.push({ key: label.toLowerCase(), label, ...l });
  }

  if (!result?.found || !localities.length) {
    return { pincode, found: false, localities: [], state: null, district: null, taluka: null, village: null, city: null, label: '' };
  }

  const state = only(localities.map((l) => l.state));
  const district = state ? only(localities.map((l) => l.district)) : null;
  const taluka = district ? only(localities.map((l) => l.taluka)) : null;
  const single = localities.length === 1 ? localities[0] : null;

  return {
    pincode,
    found: true,
    localities,
    state,
    stateCanonical: state ? localities.every((l) => l.stateCanonical) : false,
    district,
    districtCanonical: district ? localities.every((l) => l.districtCanonical) : false,
    taluka,
    talukaCanonical: taluka ? localities.every((l) => l.talukaCanonical) : false,
    village: single ? single.name : null,
    city: single ? single.name : (taluka || district),
    // "Baramati, Pune, Maharashtra" — as specific as the pincode allows.
    // Several districts: "Central Delhi / New Delhi, Delhi".
    label: district
      ? joinDistinct([single?.name, taluka, district, state], ', ')
      : joinDistinct([joinDistinct(localities.map((l) => l.district), ' / ', 3), state], ', '),
    ambiguous: !state || !district,
  };
}

// "Hingoli, Hingoli, Maharashtra" → "Hingoli, Maharashtra".
function joinDistinct(parts, sep, max = Infinity) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
    if (out.length === max) break;
  }
  return out.join(sep);
}

/**
 * The form values a locality implies. `strict` fields (pickers) only take
 * canonical names; the rest take whatever India Post has.
 *
 * @param {Locality|object} source   a Locality, or a summary for the
 *                                   shared-by-all values
 * @param {Record<string,string>} fields  form field → one of
 *        'state' | 'district' | 'taluka' | 'village' | 'city'
 * @param {string[]} [strict]  form fields that are pickers
 * @returns {Record<string,string>}
 */
export function localityToValues(source, fields, strict = []) {
  const out = {};
  if (!source) return out;
  const isLocality = typeof source.name === 'string' && !('localities' in source);
  for (const [formField, from] of Object.entries(fields || {})) {
    let value;
    let canonical = true;
    if (from === 'village') {
      value = isLocality ? source.name : source.village;
    } else if (from === 'city') {
      value = isLocality ? source.name : source.city;
    } else {
      value = source[from];
      canonical = Boolean(source[`${from}Canonical`]);
    }
    if (!value) continue;
    if (strict.includes(formField) && !canonical) continue;
    out[formField] = value;
  }
  return out;
}

/**
 * For forms whose state / district / taluka are pickers over
 * shared/constants/locations: drop what an autofill patch would put in a
 * picker that can't show it (a district outside the state's list, a
 * Maharashtra taluka outside the district's). Fields the patch doesn't touch
 * are left alone, so an older saved value survives an unrelated autofill.
 *
 * @param {{state?: string, district?: string, taluka?: string}} current
 * @param {Record<string,string>} patch
 */
export function fitPatchToLocationLists(current, patch) {
  const next = { ...current, ...patch };
  const out = { ...patch };
  if ('district' in patch && next.district && !districtsOf(next.state).includes(next.district)) {
    out.district = '';
  }
  const district = out.district ?? next.district;
  const talukaTouched = 'taluka' in patch || 'district' in patch || 'state' in patch;
  if (talukaTouched && next.state === 'Maharashtra' && next.taluka && !getTalukas(district).includes(next.taluka)) {
    out.taluka = '';
  }
  return out;
}

/** True when the PIN field's state should stop a save. */
export function pincodeBlocksSubmit(status) {
  return status === 'invalid' || status === 'not_found' || status === 'incomplete';
}
