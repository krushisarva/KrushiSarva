import { hasSellerRole, isSellerAccount, isKycVerified, SELLER_ROLES } from '../roles';

describe('hasSellerRole', () => {
  test.each(SELLER_ROLES)('%s may load the seller dashboard', (role) => {
    expect(hasSellerRole({ role })).toBe(true);
  });

  test.each(['FARMER', 'LABOUR_PROVIDER', 'MACHINERY_OWNER', undefined])('%s may not', (role) => {
    expect(hasSellerRole({ role })).toBe(false);
  });

  test('a FARMER with a business profile is still not a seller role', () => {
    // isSellerAccount accepts this account; the backend's seller routes do not.
    const legacy = { role: 'FARMER', businessType: 'krushi_kendra', gstNumber: '27ABCDE1234F1Z0' };
    expect(isSellerAccount(legacy)).toBe(true);
    expect(hasSellerRole(legacy)).toBe(false);
  });

  test('no user', () => {
    expect(hasSellerRole(null)).toBe(false);
    expect(hasSellerRole(undefined)).toBe(false);
  });
});

describe('isKycVerified', () => {
  test('reads the uppercase enum the API returns', () => {
    expect(isKycVerified({ kycStatus: 'VERIFIED' })).toBe(true);
    expect(isKycVerified({ kycStatus: 'PENDING' })).toBe(false);
    expect(isKycVerified({ kycStatus: 'verified' })).toBe(false);
  });
});
