/**
 * PIN code lookup — services/pincode.service.js.
 *
 * India Post answers HTTP 200 for every outcome, so the parser is what decides
 * found / not found / broken upstream. The fixtures below are trimmed copies of
 * real responses (413102, 396230, 999999, "abc12").
 *
 * The lookup tests pin the behaviour the forms depend on: an unknown pincode is
 * a cached RESULT, an unreachable upstream is a thrown error that is NEVER
 * cached, and concurrent misses make one upstream call.
 */
import { jest } from '@jest/globals';

const store = new Map();
const redisMock = {
  status: 'ready',
  get: jest.fn(async (k) => (store.has(k) ? store.get(k).v : null)),
  set: jest.fn(async (k, v, _ex, ttl) => { store.set(k, { v, ttl }); return 'OK'; }),
};
jest.unstable_mockModule('../../../src/config/redis.js', () => ({ default: redisMock }));

const axiosGet = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: { get: axiosGet } }));

const {
  parsePostalResponse, lookupPincode, PincodeLookupUnavailableError, _resetPincodeCacheForTests,
} = await import('../../../src/services/pincode.service.js');
const { _resetBreakers } = await import('../../../src/resilience/circuitBreaker.js');
const { resetSingleFlight } = await import('../../../src/utils/singleFlight.js');

const po = (over = {}) => ({
  Name: 'Baramati', Description: null, BranchType: 'Sub Post Office', DeliveryStatus: 'Delivery',
  Circle: 'Maharashtra', District: 'Pune', Division: 'Pune Moffusil', Region: 'Pune',
  Block: 'Baramati', State: 'Maharashtra', Country: 'India', Pincode: '413102', ...over,
});
const success = (offices) => [{ Message: `Number of pincode(s) found:${offices.length}`, Status: 'Success', PostOffice: offices }];
const NO_RECORDS = [{ Message: 'No records found', Status: 'Error', PostOffice: null }];
const BAD_PATH = [{ Status: '404', Message: 'The requested resource is not found', RequestUri: 'https://api.postalpincode.in:443/pincode/abc12' }];

describe('parsePostalResponse', () => {
  test('a normal result keeps every office, cleaned', () => {
    const r = parsePostalResponse('413102', success([
      po(),
      po({ Name: 'Baramati Court', DeliveryStatus: 'Non-Delivery' }),
    ]));
    expect(r.found).toBe(true);
    expect(r.pincode).toBe('413102');
    expect(r.postOffices).toEqual([
      { name: 'Baramati', block: 'Baramati', district: 'Pune', state: 'Maharashtra', delivery: true, branchType: 'Sub Post Office' },
      { name: 'Baramati Court', block: 'Baramati', district: 'Pune', state: 'Maharashtra', delivery: false, branchType: 'Sub Post Office' },
    ]);
  });

  test('delivery offices sort ahead of non-delivery ones', () => {
    const r = parsePostalResponse('413102', success([
      po({ Name: 'Aaa Court', DeliveryStatus: 'Non-Delivery' }),
      po({ Name: 'Zzz Village' }),
    ]));
    expect(r.postOffices.map((o) => o.name)).toEqual(['Zzz Village', 'Aaa Court']);
  });

  test.each([['NA'], ['N.A.'], ['n/a'], [''], ['  '], [null]])('block %p becomes null', (block) => {
    const r = parsePostalResponse('413102', success([po({ Block: block })]));
    expect(r.postOffices[0].block).toBeNull();
  });

  test('"(Part)" is stripped from a block name', () => {
    const r = parsePostalResponse('413102', success([po({ Block: 'Tlangnuam (Part)' })]));
    expect(r.postOffices[0].block).toBe('Tlangnuam');
  });

  test('whitespace is collapsed', () => {
    const r = parsePostalResponse('413102', success([po({ Name: '  Baramati   MIDC ', District: ' Pune ' })]));
    expect(r.postOffices[0]).toMatchObject({ name: 'Baramati MIDC', district: 'Pune' });
  });

  test('offices spanning states are all returned for the caller to disambiguate', () => {
    const r = parsePostalResponse('413102', success([
      po({ Name: 'Umbergaon', District: 'Valsad', State: 'Gujarat' }),
      po({ Name: 'Dadra', District: 'Dadra & Nagar Haveli', State: 'Dadra & Nagar Haveli' }),
    ]));
    expect(r.postOffices.map((o) => o.state).sort()).toEqual(['Dadra & Nagar Haveli', 'Gujarat']);
  });

  test('duplicate offices are dropped', () => {
    const r = parsePostalResponse('413102', success([po(), po(), po({ Name: 'BARAMATI' })]));
    expect(r.postOffices).toHaveLength(1);
  });

  test('offices missing a name, district or state are skipped', () => {
    const r = parsePostalResponse('413102', success([
      po({ Name: null }), po({ District: 'NA' }), po({ State: '' }), 'junk', null, po({ Name: 'Kept' }),
    ]));
    expect(r.postOffices.map((o) => o.name)).toEqual(['Kept']);
  });

  test('an office filed under a different pincode is skipped', () => {
    const r = parsePostalResponse('413102', success([po({ Pincode: '413103' }), po({ Name: 'Kept' })]));
    expect(r.postOffices.map((o) => o.name)).toEqual(['Kept']);
  });

  test('an office outside India is skipped', () => {
    const r = parsePostalResponse('413102', success([po({ Country: 'Nepal' }), po({ Name: 'Kept' })]));
    expect(r.postOffices.map((o) => o.name)).toEqual(['Kept']);
  });

  test('the office list is capped', () => {
    const many = Array.from({ length: 400 }, (_, i) => po({ Name: `Office ${i}` }));
    expect(parsePostalResponse('413102', success(many)).postOffices).toHaveLength(150);
  });

  test.each([
    ['"No records found"', NO_RECORDS],
    ['a "404" for a malformed path', BAD_PATH],
    ['Success with a null list', [{ Status: 'Success', PostOffice: null }]],
    ['Success with only unusable offices', success([po({ State: null })])],
  ])('%s → not found', (_label, body) => {
    expect(parsePostalResponse('999999', body)).toEqual({ pincode: '999999', found: false, postOffices: [] });
  });

  test.each([
    ['an HTML error page', '<html>502 Bad Gateway</html>'],
    ['an empty array', []],
    ['an object instead of an array', { Status: 'Success' }],
    ['null', null],
    ['an unknown status', [{ Status: 'Maintenance', Message: 'Down' }]],
    ['an Error that is not "no records"', [{ Status: 'Error', Message: 'Internal error' }]],
  ])('%s throws — a broken upstream is not "not found"', (_label, body) => {
    expect(() => parsePostalResponse('413102', body)).toThrow(/Unexpected response/);
  });
});

describe('lookupPincode', () => {
  beforeEach(() => {
    store.clear();
    axiosGet.mockReset();
    redisMock.get.mockClear();
    redisMock.set.mockClear();
    redisMock.status = 'ready';
    _resetPincodeCacheForTests();
    _resetBreakers();
    resetSingleFlight();
  });

  test('fetches, returns and caches a found pincode for ~30 days', async () => {
    axiosGet.mockResolvedValue({ data: success([po()]) });
    const r = await lookupPincode('413102');
    expect(r.found).toBe(true);
    expect(axiosGet).toHaveBeenCalledWith('https://api.postalpincode.in/pincode/413102', expect.objectContaining({ timeout: expect.any(Number) }));
    const cached = store.get('pincode:v1:413102');
    expect(JSON.parse(cached.v)).toEqual(r);
    expect(cached.ttl).toBeGreaterThan(26 * 24 * 3600);
    expect(cached.ttl).toBeLessThanOrEqual(30 * 24 * 3600);
  });

  test('a second lookup is served without calling India Post', async () => {
    axiosGet.mockResolvedValue({ data: success([po()]) });
    await lookupPincode('413102');
    await lookupPincode('413102');
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  test('a Redis hit is served without calling India Post', async () => {
    const hit = { pincode: '413102', found: true, postOffices: [{ name: 'X', block: null, district: 'Pune', state: 'Maharashtra', delivery: true, branchType: null }] };
    store.set('pincode:v1:413102', { v: JSON.stringify(hit) });
    expect(await lookupPincode('413102')).toEqual(hit);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  test('a corrupt Redis entry is ignored and refetched', async () => {
    store.set('pincode:v1:413102', { v: '{"pincode":"999999"}' });
    axiosGet.mockResolvedValue({ data: success([po()]) });
    expect((await lookupPincode('413102')).found).toBe(true);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  test('not found is cached, but only for hours', async () => {
    axiosGet.mockResolvedValue({ data: NO_RECORDS });
    const r = await lookupPincode('999999');
    expect(r).toEqual({ pincode: '999999', found: false, postOffices: [] });
    const ttl = store.get('pincode:v1:999999').ttl;
    expect(ttl).toBeGreaterThan(5 * 3600);
    expect(ttl).toBeLessThanOrEqual(6 * 3600);
  });

  test.each([['012345'], ['12345'], ['1234567'], ['41310a'], [''], [null], [undefined]])(
    '%p is not a pincode and never reaches India Post',
    async (value) => {
      const r = await lookupPincode(value);
      expect(r.found).toBe(false);
      expect(axiosGet).not.toHaveBeenCalled();
    },
  );

  test('an unreachable upstream throws 503 and caches nothing', async () => {
    axiosGet.mockRejectedValue(Object.assign(new Error('timeout of 4000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(lookupPincode('413102')).rejects.toBeInstanceOf(PincodeLookupUnavailableError);
    await expect(lookupPincode('413102')).rejects.toMatchObject({ status: 503, code: 'PINCODE_LOOKUP_UNAVAILABLE' });
    expect(store.size).toBe(0);
  });

  test('a timeout is not retried', async () => {
    axiosGet.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    await expect(lookupPincode('413102')).rejects.toBeInstanceOf(PincodeLookupUnavailableError);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });

  test('a dropped connection is retried once', async () => {
    axiosGet
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ data: success([po()]) });
    expect((await lookupPincode('413102')).found).toBe(true);
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  test('a 5xx is retried once, then reported unavailable', async () => {
    axiosGet.mockRejectedValue(Object.assign(new Error('bad gateway'), { response: { status: 502 } }));
    await expect(lookupPincode('413102')).rejects.toBeInstanceOf(PincodeLookupUnavailableError);
    expect(axiosGet).toHaveBeenCalledTimes(2);
  });

  test('a garbage body is unavailable, not "not found", and is not cached', async () => {
    axiosGet.mockResolvedValue({ data: '<html>Service Unavailable</html>' });
    await expect(lookupPincode('413102')).rejects.toBeInstanceOf(PincodeLookupUnavailableError);
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  test('concurrent lookups of one pincode make one upstream call', async () => {
    let release;
    axiosGet.mockImplementation(() => new Promise((r) => { release = () => r({ data: success([po()]) }); }));
    const all = Promise.all([lookupPincode('413102'), lookupPincode('413102'), lookupPincode('413102')]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await all;
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.found)).toBe(true);
  });

  test('works with Redis down', async () => {
    redisMock.status = 'reconnecting';
    axiosGet.mockResolvedValue({ data: success([po()]) });
    expect((await lookupPincode('413102')).found).toBe(true);
    expect(await lookupPincode('413102')).toMatchObject({ found: true });
    expect(axiosGet).toHaveBeenCalledTimes(1); // second served from the in-process cache
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  test('a Redis error does not fail the lookup', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('READONLY'));
    redisMock.set.mockRejectedValueOnce(new Error('OOM'));
    axiosGet.mockResolvedValue({ data: success([po()]) });
    expect((await lookupPincode('413102')).found).toBe(true);
  });

  test('once India Post keeps failing, the breaker stops calling it', async () => {
    axiosGet.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    const pins = ['411001', '411002', '411003', '411004', '411005'];
    for (const p of pins) await expect(lookupPincode(p)).rejects.toBeInstanceOf(PincodeLookupUnavailableError);
    const callsBefore = axiosGet.mock.calls.length;
    await expect(lookupPincode('411006')).rejects.toBeInstanceOf(PincodeLookupUnavailableError);
    expect(axiosGet.mock.calls.length).toBe(callsBefore);
  });
});
