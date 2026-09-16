/**
 * shared/services/pincodeApi.js — the client for GET /location/pincode/:pin.
 */
jest.mock('../api', () => ({ __esModule: true, default: { get: jest.fn() } }));

import api from '../api';
import {
  fetchPincode, peekPincode, PincodeLookupError, classifyLookupError, _clearPincodeCache,
} from '../pincodeApi';

const office = { name: 'Baramati', block: 'Baramati', district: 'Pune', state: 'Maharashtra', delivery: true, branchType: null };
const ok = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  api.get.mockReset();
  _clearPincodeCache();
});

test('calls the backend with the cleaned pincode', async () => {
  api.get.mockResolvedValue(ok({ pincode: '413102', found: true, postOffices: [office] }));
  const r = await fetchPincode('४१३ १०२');
  expect(api.get).toHaveBeenCalledWith('/location/pincode/413102', expect.objectContaining({ timeout: expect.any(Number) }));
  expect(r).toEqual({ pincode: '413102', found: true, postOffices: [office] });
});

test('passes the abort signal through', async () => {
  api.get.mockResolvedValue(ok({ pincode: '413102', found: true, postOffices: [office] }));
  const controller = new AbortController();
  await fetchPincode('413102', { signal: controller.signal });
  expect(api.get.mock.calls[0][1].signal).toBe(controller.signal);
});

test('a result is reused for the session', async () => {
  api.get.mockResolvedValue(ok({ pincode: '413102', found: true, postOffices: [office] }));
  await fetchPincode('413102');
  await fetchPincode('413102');
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(peekPincode('413102')).toMatchObject({ found: true });
});

test('not found is reused too', async () => {
  api.get.mockResolvedValue(ok({ pincode: '999999', found: false, postOffices: [] }));
  expect(await fetchPincode('999999')).toEqual({ pincode: '999999', found: false, postOffices: [] });
  await fetchPincode('999999');
  expect(api.get).toHaveBeenCalledTimes(1);
});

test('found with no offices is treated as not found', async () => {
  api.get.mockResolvedValue(ok({ pincode: '413102', found: true, postOffices: [] }));
  expect((await fetchPincode('413102')).found).toBe(false);
});

test('a failure is not cached — Retry goes out again', async () => {
  api.get.mockRejectedValueOnce({ response: { status: 503 } });
  await expect(fetchPincode('413102')).rejects.toMatchObject({ kind: 'unavailable' });
  expect(peekPincode('413102')).toBeUndefined();
  api.get.mockResolvedValueOnce(ok({ pincode: '413102', found: true, postOffices: [office] }));
  expect((await fetchPincode('413102')).found).toBe(true);
  expect(api.get).toHaveBeenCalledTimes(2);
});

test.each(['012345', '4131', '', null])('%p never reaches the network', async (v) => {
  await expect(fetchPincode(v)).rejects.toMatchObject({ kind: 'invalid' });
  expect(api.get).not.toHaveBeenCalled();
});

test('a response in an unexpected shape is "unavailable", not "not found"', async () => {
  api.get.mockResolvedValue({ data: '<html>' });
  await expect(fetchPincode('413102')).rejects.toBeInstanceOf(PincodeLookupError);
  await expect(fetchPincode('413102')).rejects.toMatchObject({ kind: 'unavailable' });
});

test('a cancel is rethrown as-is, not classified', async () => {
  const cancel = Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' });
  api.get.mockRejectedValue(cancel);
  await expect(fetchPincode('413102')).rejects.toBe(cancel);
});

test('the session cache is bounded', async () => {
  api.get.mockImplementation((url) => {
    const pin = url.split('/').pop();
    return Promise.resolve(ok({ pincode: pin, found: true, postOffices: [office] }));
  });
  for (let i = 0; i < 60; i++) await fetchPincode(String(400000 + i));
  expect(peekPincode('400000')).toBeUndefined();   // evicted
  expect(peekPincode('400059')).toBeDefined();
});

test('expired entries are dropped', async () => {
  const now = jest.spyOn(Date, 'now');
  now.mockReturnValue(1_000);
  api.get.mockResolvedValue(ok({ pincode: '999999', found: false, postOffices: [] }));
  await fetchPincode('999999');
  now.mockReturnValue(1_000 + 11 * 60 * 1000);   // past the 10-minute not-found TTL
  expect(peekPincode('999999')).toBeUndefined();
  now.mockRestore();
});

describe('classifyLookupError', () => {
  test.each([
    [{ response: { status: 429 } }, 'rate_limited'],
    [{ response: { status: 400 } }, 'invalid'],
    [{ response: { status: 503 } }, 'unavailable'],
    [{ response: { status: 500 } }, 'unavailable'],
    [{ response: { status: 404 } }, 'unavailable'],   // an older backend without the route
    [{ code: 'ECONNABORTED' }, 'unavailable'],        // axios timeout
    [{ code: 'ERR_NETWORK', message: 'Network Error' }, 'offline'],
    [new Error('Network Error'), 'offline'],
  ])('%p → %s', (err, kind) => {
    expect(classifyLookupError(err)).toBe(kind);
  });
});
