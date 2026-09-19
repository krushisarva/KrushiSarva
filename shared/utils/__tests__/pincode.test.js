/**
 * shared/utils/pincode.js — mapping India Post's answer onto the app's lists.
 *
 * The post offices below are the backend's cleaned form of real India Post
 * responses (413102, 110001, 400001, 402201, 413501, 194101, 396230, 605001,
 * 122001, 443001, 431122).
 */
import {
  sanitizePincode, isValidPincode, pincodeInputState, matchState, matchDistrict,
  resolveStateDistrict, matchTaluka, summarisePincode, localityToValues, pincodeBlocksSubmit,
} from '../pincode';
import { INDIA_DISTRICTS, INDIA_STATES_LIST } from '../../constants/indiaLocations';
import { getTalukas, toDistrictListName } from '../../constants/locations';

const po = (name, block, district, state, delivery = true) => ({
  name, block, district, state, delivery, branchType: 'Branch Post Office',
});
const found = (pincode, offices) => ({ pincode, found: true, postOffices: offices });

describe('sanitizePincode', () => {
  test.each([
    ['413102', '413102'],
    ['413 102', '413102'],
    ['PIN: 413-102', '413102'],
    ['4131025', '413102'],        // pasted with an extra digit
    ['४१३१०२', '413102'],          // Devanagari
    ['৪১৩১০২', '413102'],          // Bengali
    ['૪૧૩૧૦૨', '413102'],          // Gujarati
    ['௪௧௩௧௦௨', '413102'],          // Tamil
    ['４１３１０２', '413102'],      // full-width
    ['abc', ''],
    ['', ''],
    [null, ''],
    [undefined, ''],
    [413102, '413102'],
  ])('%p → %p', (input, out) => {
    expect(sanitizePincode(input)).toBe(out);
  });
});

describe('isValidPincode / pincodeInputState', () => {
  test.each(['413102', '110001', '999999', ' 413102 '])('%p is valid', (v) => {
    expect(isValidPincode(v)).toBe(true);
  });
  test.each(['012345', '000000', '41310', '4131022', '41310a', '', null])('%p is not', (v) => {
    expect(isValidPincode(v)).toBe(false);
  });

  test.each([
    ['', 'empty'],
    ['4', 'incomplete'],
    ['41310', 'incomplete'],
    ['0', 'invalid'],          // said at the first digit, not after six
    ['01234', 'invalid'],
    ['413102', 'complete'],
    ['४१३१०२', 'complete'],
  ])('%p → %s', (v, state) => {
    expect(pincodeInputState(v)).toBe(state);
  });
});

describe('matchState', () => {
  test.each([
    ['Maharashtra', 'Maharashtra'],
    ['MAHARASHTRA', 'Maharashtra'],
    ['Andaman & Nicobar', 'Andaman and Nicobar Islands'],
    ['Daman & Diu', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['Dadra & Nagar Haveli', 'Dadra and Nagar Haveli and Daman and Diu'],
    ['Pondicherry', 'Puducherry'],
    ['Jammu & Kashmir', 'Jammu and Kashmir'],
    ['Orissa', 'Odisha'],
    ['Chattisgarh', 'Chhattisgarh'],
    ['Delhi', 'Delhi'],
  ])('%p → %p', (raw, state) => {
    expect(matchState(raw)).toBe(state);
  });

  test('an unknown state is null', () => {
    expect(matchState('Atlantis')).toBeNull();
    expect(matchState('')).toBeNull();
  });

  test('every canonical state maps to itself', () => {
    for (const s of INDIA_STATES_LIST) expect(matchState(s)).toBe(s);
  });
});

describe('matchDistrict', () => {
  test.each([
    ['Maharashtra', 'Pune', 'Pune'],
    ['Maharashtra', 'Raigarh(MH)', 'Raigad'],
    ['Maharashtra', 'Osmanabad', 'Dharashiv'],
    ['Maharashtra', 'Ahmed Nagar', 'Ahmednagar'],
    ['Maharashtra', 'Buldana', 'Buldhana'],
    ['Maharashtra', 'Bid', 'Beed'],
    ['Maharashtra', 'Gondiya', 'Gondia'],
    ['Haryana', 'Gurgaon', 'Gurugram'],
    ['Puducherry', 'Pondicherry', 'Puducherry'],
    ['Karnataka', 'Bangalore', 'Bengaluru Urban'],
    ['Assam', 'Kamrup Metro', 'Kamrup Metropolitan'],
  ])('%s / %p → %p', (state, raw, district) => {
    expect(matchDistrict(state, raw)).toBe(district);
  });

  test('"Mumbai" matches two districts, so neither', () => {
    expect(matchDistrict('Maharashtra', 'Mumbai')).toBeNull();
  });

  test('a Chhattisgarh district is not found in Maharashtra', () => {
    expect(matchDistrict('Maharashtra', 'Bastar')).toBeNull();
  });

  test('unknown state or empty name is null', () => {
    expect(matchDistrict('Atlantis', 'Pune')).toBeNull();
    expect(matchDistrict('Maharashtra', '')).toBeNull();
    expect(matchDistrict('Maharashtra', null)).toBeNull();
  });

  test('fuzzy matching is off when asked', () => {
    expect(matchDistrict('Maharashtra', 'Buldana', { fuzzy: false })).toBeNull();
    expect(matchDistrict('Maharashtra', 'Pune', { fuzzy: false })).toBe('Pune');
  });

  test('every canonical district maps to itself', () => {
    for (const [state, list] of Object.entries(INDIA_DISTRICTS)) {
      for (const d of list) expect(matchDistrict(state, d)).toBe(d);
    }
  });
});

describe('resolveStateDistrict', () => {
  test('Leh filed under Jammu & Kashmir resolves to Ladakh', () => {
    expect(resolveStateDistrict('Jammu & Kashmir', 'Leh')).toEqual({
      state: 'Ladakh', stateCanonical: true, district: 'Leh', districtCanonical: true,
    });
  });

  test('an unmatched district keeps the state and India Post\'s name, tag stripped', () => {
    expect(resolveStateDistrict('Maharashtra', 'Mumbai')).toEqual({
      state: 'Maharashtra', stateCanonical: true, district: 'Mumbai', districtCanonical: false,
    });
    expect(resolveStateDistrict('Maharashtra', 'Somewhere(MH)').district).toBe('Somewhere');
  });

  test('an unknown state is kept as written', () => {
    expect(resolveStateDistrict('Atlantis', 'Nowhere')).toEqual({
      state: 'Atlantis', stateCanonical: false, district: 'Nowhere', districtCanonical: false,
    });
  });

  test('an ambiguous district name does not move the state', () => {
    // "Aurangabad" is a district of both Maharashtra and Bihar.
    expect(resolveStateDistrict('Maharashtra', 'Aurangabad').state).toBe('Maharashtra');
    expect(resolveStateDistrict('Bihar', 'Aurangabad').state).toBe('Bihar');
  });
});

describe('matchTaluka', () => {
  test('a block that is a taluka', () => {
    expect(matchTaluka('Maharashtra', 'Pune', 'Baramati')).toBe('Baramati');
  });
  test('spelling drift', () => {
    expect(matchTaluka('Maharashtra', 'Beed', 'Bid')).toBe('Beed');
  });
  test('a renamed district still finds its talukas', () => {
    expect(matchTaluka('Maharashtra', 'Dharashiv', 'Tuljapur')).toBe('Tuljapur');
    expect(getTalukas('Dharashiv')).toContain('Tuljapur');
  });
  test('Haveli and Velhe share a consonant key, so neither guesses', () => {
    expect(matchTaluka('Maharashtra', 'Pune', 'Havli')).toBeNull();
  });
  test('no taluka list outside Maharashtra', () => {
    expect(matchTaluka('Gujarat', 'Valsad', 'Umbergaon')).toBeNull();
  });
  test('missing block', () => {
    expect(matchTaluka('Maharashtra', 'Pune', null)).toBeNull();
  });
});

describe('summarisePincode', () => {
  test('one district, many villages: shared fields filled, village left to choose', () => {
    const s = summarisePincode(found('413102', [
      po('Baramati', 'Baramati', 'Pune', 'Maharashtra'),
      po('Barhanpur', 'Baramati', 'Pune', 'Maharashtra'),
      po('Baramati Court', 'Baramati', 'Pune', 'Maharashtra', false),
    ]));
    expect(s).toMatchObject({
      found: true, pincode: '413102', ambiguous: false,
      state: 'Maharashtra', stateCanonical: true,
      district: 'Pune', districtCanonical: true,
      taluka: 'Baramati', talukaCanonical: true,
      village: null, city: 'Baramati',
      label: 'Baramati, Pune, Maharashtra',
    });
    expect(s.localities.map((l) => l.label)).toEqual(['Baramati', 'Barhanpur', 'Baramati Court']);
  });

  test('a single office fills the village too', () => {
    const s = summarisePincode(found('402201', [po('Alibag', 'Alibag', 'Raigarh(MH)', 'Maharashtra')]));
    expect(s).toMatchObject({
      state: 'Maharashtra', district: 'Raigad', districtCanonical: true,
      taluka: 'Alibag', village: 'Alibag', city: 'Alibag', label: 'Alibag, Raigad, Maharashtra',
    });
  });

  test('two districts: district and taluka left open', () => {
    const s = summarisePincode(found('110001', [
      po('Connaught Place', 'New Delhi', 'Central Delhi', 'Delhi'),
      po('Parliament House', 'New Delhi', 'New Delhi', 'Delhi'),
    ]));
    expect(s).toMatchObject({ state: 'Delhi', district: null, taluka: null, ambiguous: true });
    expect(s.label).toBe('Central Delhi / New Delhi, Delhi');
    expect(s.city).toBeNull();
  });

  test('two states: nothing shared is claimed', () => {
    const s = summarisePincode(found('396230', [
      po('Umbergaon', 'Umbergaon', 'Valsad', 'Gujarat'),
      po('Silvassa', 'Dadra & Nagar Haveli', 'Dadra & Nagar Haveli', 'Dadra & Nagar Haveli'),
    ]));
    expect(s).toMatchObject({ state: null, district: null, ambiguous: true });
    expect(s.label).toBe('Valsad / Dadra and Nagar Haveli');
    const silvassa = s.localities.find((l) => l.name === 'Silvassa');
    expect(silvassa).toMatchObject({
      state: 'Dadra and Nagar Haveli and Daman and Diu', district: 'Dadra and Nagar Haveli', districtCanonical: true,
    });
  });

  test('a district the list does not have is reported, but flagged', () => {
    const s = summarisePincode(found('400001', [
      po('Mumbai GPO', 'Mumbai', 'Mumbai', 'Maharashtra'),
      po('Town Hall', 'Mumbai', 'Mumbai', 'Maharashtra'),
    ]));
    expect(s).toMatchObject({ district: 'Mumbai', districtCanonical: false, taluka: 'Mumbai', talukaCanonical: false });
  });

  test('the same village name under two blocks gets told apart', () => {
    const s = summarisePincode(found('413102', [
      po('Malegaon', 'Baramati', 'Pune', 'Maharashtra'),
      po('Malegaon', 'Indapur', 'Pune', 'Maharashtra'),
    ]));
    expect(s.localities.map((l) => l.label)).toEqual(['Malegaon, Baramati', 'Malegaon, Indapur']);
    expect(new Set(s.localities.map((l) => l.key)).size).toBe(2);
  });

  test('a taluka name shared by two districts never moves the district', () => {
    // Khed is a taluka of both Pune and Ratnagiri; filed under Thane it stays Thane.
    const s = summarisePincode(found('400000', [po('Somewhere', 'Khed', 'Thane', 'Maharashtra')]));
    expect(s).toMatchObject({ district: 'Thane', taluka: 'Khed', talukaCanonical: false });
  });

  test('a block naming a taluka of exactly one other district moves it there', () => {
    const s = summarisePincode(found('401404', [po('Palghar', 'Palghar', 'Thane', 'Maharashtra')]));
    expect(s).toMatchObject({ district: 'Palghar', taluka: 'Palghar', talukaCanonical: true });
  });

  test('taluka equal to district is not repeated in the label', () => {
    const s = summarisePincode(found('431122', [po('Beed', 'Bid', 'Beed', 'Maharashtra')]));
    expect(s.label).toBe('Beed, Maharashtra');
  });

  test.each([
    [{ pincode: '999999', found: false, postOffices: [] }],
    [found('413102', [])],
    [found('413102', [{ name: 'X' }])],
    [null],
    [undefined],
  ])('nothing usable → not found (%#)', (result) => {
    const s = summarisePincode(result);
    expect(s.found).toBe(false);
    expect(s.localities).toEqual([]);
    expect(s.state).toBeNull();
  });
});

describe('localityToValues', () => {
  const summary = summarisePincode(found('400001', [
    po('Mumbai GPO', 'Mumbai', 'Mumbai', 'Maharashtra'),
    po('Town Hall', 'Mumbai', 'Mumbai', 'Maharashtra'),
  ]));

  test('text fields take India Post\'s name when the list has none', () => {
    expect(localityToValues(summary, { st: 'state', dist: 'district', town: 'city' })).toEqual({
      st: 'Maharashtra', dist: 'Mumbai', town: 'Mumbai',
    });
  });

  test('picker fields only take canonical names', () => {
    expect(localityToValues(summary, { st: 'state', dist: 'district', tal: 'taluka' }, ['dist', 'tal'])).toEqual({
      st: 'Maharashtra',
    });
  });

  test('a locality fills village and city with its own name', () => {
    const loc = summary.localities[1];
    expect(localityToValues(loc, { village: 'village', city: 'city', district: 'district' })).toEqual({
      village: 'Town Hall', city: 'Town Hall', district: 'Mumbai',
    });
  });

  test('empty inputs', () => {
    expect(localityToValues(null, { a: 'state' })).toEqual({});
    expect(localityToValues(summary, null)).toEqual({});
  });
});

describe('pincodeBlocksSubmit', () => {
  test.each([
    ['invalid', true], ['not_found', true], ['incomplete', true],
    ['idle', false], ['loading', false], ['found', false],
    ['unavailable', false], ['offline', false], ['rate_limited', false],
  ])('%s → %s', (status, blocks) => {
    expect(pincodeBlocksSubmit(status)).toBe(blocks);
  });
});

describe('toDistrictListName (Rent district picker)', () => {
  test('renamed districts map back to the picker spelling', () => {
    expect(toDistrictListName('Dharashiv')).toBe('Osmanabad');
    expect(toDistrictListName('Ahilyanagar')).toBe('Ahmednagar');
    expect(toDistrictListName('Chhatrapati Sambhajinagar')).toBe('Aurangabad');
  });
  test('a listed district passes through; others are null', () => {
    expect(toDistrictListName('Pune')).toBe('Pune');
    expect(toDistrictListName('Central Delhi')).toBeNull();
    expect(toDistrictListName('')).toBeNull();
  });
});
