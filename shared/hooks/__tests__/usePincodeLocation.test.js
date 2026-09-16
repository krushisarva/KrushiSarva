/**
 * shared/hooks/usePincodeLocation.js — the lookup lifecycle and the autofill
 * rules every location form relies on.
 */
import React, { act, useState } from 'react';
import TestRenderer from 'react-test-renderer';

// The real client pulls in Expo config, which this node runner can't parse.
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../services/pincodeApi', () => {
  const actual = jest.requireActual('../../services/pincodeApi');
  return { ...actual, fetchPincode: jest.fn(), peekPincode: jest.fn(() => undefined) };
});

import { fetchPincode, peekPincode, PincodeLookupError } from '../../services/pincodeApi';
import { usePincodeLookup, usePincodeAutofill } from '../usePincodeLocation';

global.IS_REACT_ACT_ENVIRONMENT = true;

// react-test-renderer 19 logs a deprecation on every create(); it is still the
// lightest way to drive a hook under this node-only config.
const realConsoleError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((msg, ...rest) => {
    if (String(msg).includes('react-test-renderer is deprecated')) return;
    realConsoleError(msg, ...rest);
  });
});
afterAll(() => console.error.mockRestore());

const po = (name, block, district, state = 'Maharashtra') => ({
  name, block, district, state, delivery: true, branchType: null,
});
const RESULTS = {
  413102: { pincode: '413102', found: true, postOffices: [po('Baramati', 'Baramati', 'Pune'), po('Barhanpur', 'Baramati', 'Pune')] },
  413106: { pincode: '413106', found: true, postOffices: [po('Indapur', 'Indapur', 'Pune')] },
  416416: { pincode: '416416', found: true, postOffices: [po('Sangli', 'Miraj', 'Sangli')] },
  110001: { pincode: '110001', found: true, postOffices: [po('Connaught Place', 'New Delhi', 'Central Delhi', 'Delhi'), po('Parliament House', 'New Delhi', 'New Delhi', 'Delhi')] },
  999999: { pincode: '999999', found: false, postOffices: [] },
};

function respondFromTable() {
  fetchPincode.mockImplementation((pin, { signal } = {}) => new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError' })));
    Promise.resolve().then(() => resolve(RESULTS[pin]));
  }));
}

async function flush(ms = 400) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchPincode.mockReset();
  peekPincode.mockReset();
  peekPincode.mockReturnValue(undefined);
  respondFromTable();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── usePincodeLookup ─────────────────────────────────────────────────────────

function renderLookup(initial) {
  const out = { current: null, setPin: null };
  function Probe() {
    const [pin, setPin] = useState(initial);
    out.setPin = setPin;
    out.current = usePincodeLookup(pin);
    return null;
  }
  act(() => { TestRenderer.create(<Probe />); });
  return out;
}

describe('usePincodeLookup', () => {
  test('empty → idle, partial → incomplete, leading zero → invalid; none hit the network', async () => {
    const h = renderLookup('');
    expect(h.current.status).toBe('idle');
    act(() => h.setPin('4131'));
    expect(h.current.status).toBe('incomplete');
    act(() => h.setPin('0'));
    expect(h.current.status).toBe('invalid');
    await flush();
    expect(fetchPincode).not.toHaveBeenCalled();
  });

  test('six digits → loading → found with a summary', async () => {
    const h = renderLookup('413102');
    expect(h.current.status).toBe('loading');
    await flush();
    expect(h.current.status).toBe('found');
    expect(h.current.summary).toMatchObject({ district: 'Pune', taluka: 'Baramati' });
  });

  test('unknown pincode → not_found', async () => {
    const h = renderLookup('999999');
    await flush();
    expect(h.current.status).toBe('not_found');
    expect(h.current.summary).toBeNull();
  });

  test.each(['unavailable', 'offline', 'rate_limited'])('a %s failure is reported, and Retry refetches', async (kind) => {
    fetchPincode.mockRejectedValueOnce(new PincodeLookupError(kind));
    const h = renderLookup('413102');
    await flush();
    expect(h.current.status).toBe(kind);
    act(() => h.current.retry());
    expect(h.current.status).toBe('loading');
    await flush();
    expect(h.current.status).toBe('found');
    expect(fetchPincode).toHaveBeenCalledTimes(2);
  });

  test('a cached pincode resolves with no spinner and no request', () => {
    peekPincode.mockImplementation((pin) => RESULTS[pin]);
    const h = renderLookup('413102');
    expect(h.current.status).toBe('found');
    expect(fetchPincode).not.toHaveBeenCalled();
  });

  test('typing quickly past a pincode never requests it', async () => {
    const h = renderLookup('413102');
    act(() => { jest.advanceTimersByTime(100); });
    act(() => h.setPin('413106'));
    await flush();
    expect(fetchPincode).toHaveBeenCalledTimes(1);
    expect(fetchPincode.mock.calls[0][0]).toBe('413106');
    expect(h.current.summary.district).toBe('Pune');
  });

  test('a slow answer for an old pincode never overwrites the new one', async () => {
    let releaseOld;
    fetchPincode.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = () => resolve(RESULTS[416416]); }));
    const h = renderLookup('416416');
    await flush();                        // request for 416416 is in flight
    act(() => h.setPin('413102'));
    await flush();                        // 413102 resolved
    expect(h.current.summary.district).toBe('Pune');
    await act(async () => { releaseOld(); });
    expect(h.current.pincode).toBe('413102');
    expect(h.current.summary.district).toBe('Pune');
  });

  test('never shows the previous pincode\'s result for the new value', async () => {
    const h = renderLookup('413102');
    await flush();
    act(() => h.setPin('41310'));
    expect(h.current.status).toBe('incomplete');
    expect(h.current.summary).toBeNull();
  });
});

// ── usePincodeAutofill ───────────────────────────────────────────────────────

const FIELDS = { state: 'state', district: 'district', taluka: 'taluka', village: 'village' };

function renderForm(initialForm, { strict = ['state', 'district', 'taluka'], savedPincode } = {}) {
  const out = { form: null, pin: null, setForm: null, rerender: null, reopen: null };
  function Form({ saved, resetKey }) {
    const [form, setForm] = useState(initialForm);
    out.form = form;
    out.setForm = setForm;
    out.pin = usePincodeAutofill({
      pincode: form.pincode,
      values: form,
      fields: FIELDS,
      strict,
      savedPincode: saved,
      resetKey,
      onChange: (patch) => setForm((f) => ({ ...f, ...patch })),
    });
    return null;
  }
  let root;
  act(() => { root = TestRenderer.create(<Form saved={savedPincode} resetKey="a" />); });
  out.rerender = (saved) => act(() => root.update(<Form saved={saved} resetKey="a" />));
  // One sheet reused for another record: new values and a new key in one render.
  out.reopen = (resetKey, values) => act(() => {
    out.setForm(values);
    root.update(<Form saved={savedPincode} resetKey={resetKey} />);
  });
  return out;
}

const blank = { pincode: '', state: '', district: '', taluka: '', village: '' };
const type = (h, pincode) => act(() => h.setForm((f) => ({ ...f, pincode })));

describe('usePincodeAutofill', () => {
  test('typing a pincode fills what its villages share', async () => {
    const h = renderForm(blank);
    type(h, '413102');
    await flush();
    expect(h.form).toMatchObject({ state: 'Maharashtra', district: 'Pune', taluka: 'Baramati', village: '' });
    expect(h.pin.localities).toHaveLength(2);
    expect(h.pin.selectedKey).toBeNull();
  });

  test('a single-village pincode fills the village and marks it selected', async () => {
    const h = renderForm(blank);
    type(h, '413106');
    await flush();
    expect(h.form).toMatchObject({ district: 'Pune', taluka: 'Indapur', village: 'Indapur' });
    expect(h.pin.selectedKey).toBe('indapur');
  });

  test('picking a village fills it in', async () => {
    const h = renderForm(blank);
    type(h, '413102');
    await flush();
    act(() => h.pin.selectLocality(h.pin.localities[1]));
    expect(h.form.village).toBe('Barhanpur');
    expect(h.pin.selectedKey).toBe(h.pin.localities[1].key);
  });

  test('state and district follow a typed pincode over what the user picked', async () => {
    const h = renderForm({ ...blank, state: 'Maharashtra', district: 'Nashik', taluka: 'Niphad' });
    type(h, '413102');
    await flush();
    expect(h.form).toMatchObject({ district: 'Pune', taluka: 'Baramati' });
  });

  test('a village the user typed survives a pincode change', async () => {
    const h = renderForm(blank);
    act(() => h.setForm((f) => ({ ...f, village: 'Katewadi' })));
    type(h, '413106');
    await flush();
    expect(h.form.village).toBe('Katewadi');
  });

  test('changing to another district replaces what autofill wrote', async () => {
    const h = renderForm(blank);
    type(h, '413106');
    await flush();
    expect(h.form).toMatchObject({ district: 'Pune', taluka: 'Indapur', village: 'Indapur' });
    type(h, '416416');
    await flush();
    expect(h.form).toMatchObject({ district: 'Sangli', taluka: 'Miraj', village: 'Sangli' });
  });

  test('a district change clears a taluka picker it cannot refill', async () => {
    const h = renderForm({ ...blank, state: 'Maharashtra', district: 'Nashik', taluka: 'Niphad' });
    type(h, '110001');   // Delhi: no taluka list, two districts
    await flush();
    expect(h.form.state).toBe('Delhi');
    expect(h.form.taluka).toBe('');
  });

  test('an ambiguous pincode clears what autofill wrote for the previous one', async () => {
    const h = renderForm(blank);
    type(h, '413102');
    await flush();
    expect(h.form.district).toBe('Pune');
    type(h, '110001');
    await flush();
    expect(h.form).toMatchObject({ state: 'Delhi', district: '', taluka: '' });
    act(() => h.pin.selectLocality(h.pin.localities.find((l) => l.name === 'Parliament House')));
    expect(h.form).toMatchObject({ state: 'Delhi', district: 'New Delhi', village: 'Parliament House' });
  });

  test('opening a saved form fills blanks but never overwrites', async () => {
    const h = renderForm({ ...blank, pincode: '413102', state: 'Maharashtra', district: 'Satara', taluka: '' });
    await flush();
    expect(h.form).toMatchObject({ district: 'Satara', taluka: 'Baramati' });
  });

  test('a record that loads after mount is treated as opened, via savedPincode', async () => {
    const h = renderForm(blank, { savedPincode: '' });
    act(() => h.setForm({ ...blank, pincode: '413102', state: 'Maharashtra', district: 'Satara', taluka: 'Wai' }));
    h.rerender('413102');
    await flush();
    expect(h.form).toMatchObject({ district: 'Satara', taluka: 'Wai' });
  });

  test('a sheet reopened for another record treats it as opened', async () => {
    const h = renderForm(blank);
    type(h, '413106');
    await flush();
    expect(h.form.district).toBe('Pune');
    h.reopen('b', { ...blank, pincode: '413106', state: 'Maharashtra', district: 'Satara', taluka: 'Wai' });
    await flush();
    expect(h.form).toMatchObject({ district: 'Satara', taluka: 'Wai', village: 'Indapur' });
  });

  test('a form that passes through a stale PIN while loading stays "opened"', async () => {
    const h = renderForm({ ...blank, pincode: '416416' }, { savedPincode: '416416' });
    await flush();
    // The record reloads: values arrive, then the saved PIN, as a modal does.
    act(() => h.setForm({ ...blank, pincode: '' }));
    act(() => h.setForm({ ...blank, pincode: '413102', state: 'Maharashtra', district: 'Satara', taluka: 'Wai' }));
    h.rerender('413102');
    await flush();
    expect(h.form).toMatchObject({ district: 'Satara', taluka: 'Wai' });
  });

  test('editing the opened pincode switches to typed rules', async () => {
    const h = renderForm({ ...blank, pincode: '413102', state: 'Maharashtra', district: 'Satara', taluka: 'Wai' });
    await flush();
    type(h, '413106');
    await flush();
    expect(h.form).toMatchObject({ district: 'Pune', taluka: 'Indapur' });
  });

  test('not found writes nothing and blocks submit', async () => {
    const h = renderForm({ ...blank, district: 'Pune' });
    type(h, '999999');
    await flush();
    expect(h.form.district).toBe('Pune');
    expect(h.pin.status).toBe('not_found');
    expect(h.pin.blocksSubmit).toBe(true);
  });

  test('India Post down writes nothing and does not block submit', async () => {
    fetchPincode.mockRejectedValueOnce(new PincodeLookupError('unavailable'));
    const h = renderForm({ ...blank, district: 'Pune' });
    type(h, '413102');
    await flush();
    expect(h.pin.status).toBe('unavailable');
    expect(h.pin.blocksSubmit).toBe(false);
    expect(h.form.district).toBe('Pune');
  });

  test('text fields accept names the pickers would refuse', async () => {
    fetchPincode.mockResolvedValueOnce({ pincode: '400001', found: true, postOffices: [po('Mumbai GPO', 'Mumbai', 'Mumbai')] });
    const h = renderForm(blank, { strict: [] });
    type(h, '400001');
    await flush();
    expect(h.form).toMatchObject({ district: 'Mumbai', taluka: 'Mumbai', village: 'Mumbai GPO' });
  });

  test('pickers skip names not in their list', async () => {
    fetchPincode.mockResolvedValueOnce({ pincode: '400001', found: true, postOffices: [po('Mumbai GPO', 'Mumbai', 'Mumbai')] });
    const h = renderForm(blank);
    type(h, '400001');
    await flush();
    expect(h.form).toMatchObject({ state: 'Maharashtra', district: '', taluka: '', village: 'Mumbai GPO' });
  });

  test('a result is applied once, not on every re-render', async () => {
    const h = renderForm(blank);
    type(h, '413102');
    await flush();
    act(() => h.setForm((f) => ({ ...f, taluka: 'Daund' })));
    act(() => h.setForm((f) => ({ ...f, village: 'x' })));
    await flush();
    expect(h.form.taluka).toBe('Daund');
  });
});
