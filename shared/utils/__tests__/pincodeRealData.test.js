/**
 * summarisePincode against REAL India Post answers.
 *
 * fixtures/indiaPostSamples.json is the backend's cleaned output for these
 * pincodes, captured live on 2026-09-16 (backend/scripts/smoke-pincode.mjs
 * shows how), trimmed to at most two offices per district. Each one carries a
 * quirk the mapping has to survive.
 */
import samples from './fixtures/indiaPostSamples.json';
import { summarisePincode, localityToValues } from '../pincode';
import { getDistricts } from '../../constants/indiaLocations';
import { getTalukas } from '../../constants/locations';

const summary = (pin) => summarisePincode(samples[pin]);
const PICKERS = { state: 'state', district: 'district', taluka: 'taluka' };
const pickerValues = (pin) => localityToValues(summary(pin), PICKERS, ['state', 'district', 'taluka']);

test('413102 Baramati — a plain village pincode fills every picker', () => {
  expect(pickerValues('413102')).toEqual({ state: 'Maharashtra', district: 'Pune', taluka: 'Baramati' });
});

test('413209 Madha — a taluka the list used to miss (captured 2026-09-19)', () => {
  expect(pickerValues('413209')).toEqual({ state: 'Maharashtra', district: 'Solapur', taluka: 'Madha' });
});

test('402201 Alibag — "Raigarh(MH)" is Raigad', () => {
  expect(pickerValues('402201')).toEqual({ state: 'Maharashtra', district: 'Raigad', taluka: 'Alibag' });
});

test('413501 Osmanabad — the renamed district, with its taluka', () => {
  expect(pickerValues('413501')).toEqual({ state: 'Maharashtra', district: 'Dharashiv', taluka: 'Osmanabad' });
});

test('401404 Palghar — filed under Thane, moved to Palghar by its taluka', () => {
  expect(pickerValues('401404')).toEqual({ state: 'Maharashtra', district: 'Palghar', taluka: 'Palghar' });
});

test('431001 Aurangabad — old name kept by the list', () => {
  expect(pickerValues('431001')).toEqual({ state: 'Maharashtra', district: 'Aurangabad', taluka: 'Aurangabad' });
});

test('400001 Mumbai — offices in Mumbai and Raigad: state only', () => {
  const s = summary('400001');
  expect(s).toMatchObject({ state: 'Maharashtra', district: null, ambiguous: true });
  expect(s.localities.find((l) => l.name === 'Elephanta Caves Po')).toMatchObject({ district: 'Raigad', taluka: 'Uran' });
  // "Mumbai" is not one district in the list (City / Suburban), so a picker gets nothing.
  expect(s.localities.find((l) => l.name === 'Bazargate')).toMatchObject({ district: 'Mumbai', districtCanonical: false });
});

test('110001 New Delhi — two districts, one state', () => {
  const s = summary('110001');
  expect(s).toMatchObject({ state: 'Delhi', district: null });
  expect(new Set(s.localities.map((l) => l.district))).toEqual(new Set(['New Delhi', 'Central Delhi']));
});

test('396230 — Gujarat and Dadra & Nagar Haveli: nothing shared', () => {
  const s = summary('396230');
  expect(s).toMatchObject({ state: null, district: null });
  expect(new Set(s.localities.map((l) => l.state))).toEqual(
    new Set(['Gujarat', 'Dadra and Nagar Haveli and Daman and Diu']),
  );
});

test('194101 Leh — filed under Jammu & Kashmir, is Ladakh', () => {
  expect(pickerValues('194101')).toMatchObject({ state: 'Ladakh', district: 'Leh' });
});

test('605001 Pondicherry — Puducherry', () => {
  expect(pickerValues('605001')).toMatchObject({ state: 'Puducherry', district: 'Puducherry' });
});

test('122001 Gurgaon — Gurugram', () => {
  expect(pickerValues('122001')).toMatchObject({ state: 'Haryana', district: 'Gurugram' });
});

test('744101 Port Blair — "Andaman & Nicobar"', () => {
  const s = summary('744101');
  expect(s).toMatchObject({ state: 'Andaman and Nicobar Islands', district: 'South Andaman' });
  // "Port Blair" and "Portblair" are the same taluka spelled twice; no taluka
  // list exists outside Maharashtra, so the text is kept, not claimed shared.
  expect(s.taluka).toBeNull();
});

test('403001 Panaji — Goa', () => {
  expect(pickerValues('403001')).toMatchObject({ state: 'Goa', district: 'North Goa' });
});

test('999999 — not found', () => {
  expect(summary('999999')).toMatchObject({ found: false, localities: [] });
});

test('every picker value is one the pickers actually list', () => {
  for (const pin of Object.keys(samples)) {
    for (const loc of summary(pin).localities) {
      const v = localityToValues(loc, PICKERS, ['state', 'district', 'taluka']);
      if (v.district) expect(getDistricts(v.state)).toContain(v.district);
      if (v.taluka) expect(getTalukas(v.district)).toContain(v.taluka);
    }
  }
});
