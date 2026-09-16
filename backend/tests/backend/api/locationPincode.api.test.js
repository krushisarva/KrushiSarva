/**
 * GET /api/v1/location/pincode/:pincode — the lookup every location form uses.
 *
 * India Post is mocked at the axios boundary; the real service, route,
 * validation and auth run. What the apps depend on:
 *   - unknown pincode → 200 { found: false }, so a typo is never a failed request
 *   - India Post down → 503 with a machine-readable code, so the form can let
 *     the user carry on by hand instead of blocking
 *   - malformed input never reaches India Post
 */
import { jest } from '@jest/globals';

const axiosGet = jest.fn();
const realAxios = (await import('axios')).default;
// Only the pincode service's GETs to India Post are intercepted; supertest and
// anything else keep the real client.
jest.unstable_mockModule('axios', () => ({
  default: new Proxy(realAxios, {
    get: (target, prop) => (prop === 'get'
      ? (url, ...rest) => (String(url).startsWith('https://api.postalpincode.in/')
        ? axiosGet(url, ...rest)
        : target.get(url, ...rest))
      : target[prop]),
  }),
}));

const request = (await import('supertest')).default;
const { getApp, createTestUser, cleanupTestData } = await import('../../fixtures/setup.js');
const { _resetPincodeCacheForTests } = await import('../../../src/services/pincode.service.js');
const { _resetBreakers } = await import('../../../src/resilience/circuitBreaker.js');
const redis = (await import('../../../src/config/redis.js')).default;

const API = '/api/v1/location/pincode';

let app; let user;

const office = {
  Name: 'Baramati', BranchType: 'Sub Post Office', DeliveryStatus: 'Delivery', District: 'Pune',
  Block: 'Baramati', State: 'Maharashtra', Country: 'India', Pincode: '413102',
};

beforeAll(async () => {
  app = await getApp();
  user = await createTestUser();
});

afterAll(async () => { await cleanupTestData(); });

beforeEach(async () => {
  axiosGet.mockReset();
  _resetPincodeCacheForTests();
  _resetBreakers();
  if (redis.status === 'ready') {
    await redis.del('pincode:v1:413102', 'pincode:v1:999999', 'pincode:v1:411001');
  }
});

test('a known pincode returns its post offices', async () => {
  axiosGet.mockResolvedValue({ data: [{ Status: 'Success', Message: 'found:1', PostOffice: [office] }] });
  const res = await request(app).get(`${API}/413102`).set(user.headers);
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({
    pincode: '413102',
    found: true,
    postOffices: [{
      name: 'Baramati', block: 'Baramati', district: 'Pune', state: 'Maharashtra',
      delivery: true, branchType: 'Sub Post Office',
    }],
  });
  expect(res.headers['cache-control']).toMatch(/max-age=86400/);
});

test('an unknown pincode is a 200 with found: false', async () => {
  axiosGet.mockResolvedValue({ data: [{ Status: 'Error', Message: 'No records found', PostOffice: null }] });
  const res = await request(app).get(`${API}/999999`).set(user.headers);
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ pincode: '999999', found: false, postOffices: [] });
});

test('India Post being down is a 503 the app can recognise', async () => {
  axiosGet.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
  const res = await request(app).get(`${API}/411001`).set(user.headers);
  expect(res.status).toBe(503);
  expect(res.body.error.details).toEqual({ code: 'PINCODE_LOOKUP_UNAVAILABLE' });
  expect(res.headers['retry-after']).toBe('30');
});

test.each([['012345'], ['41310'], ['4131022'], ['41310x'], ['%20413102']])(
  '%s is rejected before reaching India Post',
  async (pin) => {
    const res = await request(app).get(`${API}/${pin}`).set(user.headers);
    expect(res.status).toBe(400);
    expect(axiosGet).not.toHaveBeenCalled();
  },
);

test('requires a signed-in user', async () => {
  const res = await request(app).get(`${API}/413102`);
  expect(res.status).toBe(401);
  expect(axiosGet).not.toHaveBeenCalled();
});
