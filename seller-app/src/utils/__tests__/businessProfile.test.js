import {
  applyFieldChange, buildBusinessProfilePayload, canonicalDistrict, canonicalTaluka,
  completionFromForm, completionFromUser, firstErrorKey, hasUnsavedChanges,
  initialFormFromUser, isProfileHydrated, kycState, onFileFromUser,
  serverFieldErrorKeys, serverFieldMessage, validateBusinessProfile,
} from '../businessProfile';

// Shaped like GET /users/me: encrypted fields arrive masked, IFSC in full.
const storedSeller = {
  id: 'u1',
  role: 'SELLER',
  name: 'Shree Krushi Kendra',
  businessType: 'krushi_kendra',
  district: 'Pune',
  taluka: 'Haveli',
  village: 'Wagholi',
  gstNumber: '27ABCDE1234F1Z0',
  gstOptOut: false,
  kycStatus: 'PENDING',
  sellerProfile: {
    bankHolderName: 'Ramesh Patil',
    bankName: 'State Bank of India',
    bankIfsc: 'SBIN0012345',
    bankAccountNumber: '••••••4321',
    aadharNumber: '••••-••••-0124',
    panNumber: 'ABCDE•••4F',
    kycVerifiedAt: null,
    kycRejectedReason: null,
  },
};

// What AuthContext holds straight after an OTP login.
const loginUser = { id: 'u1', phone: '9876543210', name: 'Shree Krushi Kendra', role: 'SELLER', language: 'mr' };

const validNewSeller = {
  ...initialFormFromUser({ role: 'FARMER', sellerProfile: null }),
  name: 'Ramesh Patil',
  businessType: 'individual_farmer',
  district: 'Pune',
  taluka: 'Haveli',
  village: 'Wagholi',
};

describe('isProfileHydrated', () => {
  test('the login response is not a profile', () => {
    expect(isProfileHydrated(loginUser)).toBe(false);
  });
  test('GET /users/me is, even for a user with no seller profile row', () => {
    expect(isProfileHydrated(storedSeller)).toBe(true);
    expect(isProfileHydrated({ ...loginUser, sellerProfile: null })).toBe(true);
  });
  test('no user', () => {
    expect(isProfileHydrated(null)).toBe(false);
  });
});

describe('kycState', () => {
  test('reads the uppercase enum', () => {
    expect(kycState({ ...storedSeller, kycStatus: 'VERIFIED' }).key).toBe('verified');
  });
  test('rejected carries the admin reason', () => {
    const user = {
      ...storedSeller,
      kycStatus: 'REJECTED',
      sellerProfile: { ...storedSeller.sellerProfile, kycRejectedReason: '  PAN does not match name ' },
    };
    expect(kycState(user)).toEqual({ key: 'rejected', reason: 'PAN does not match name' });
  });
  test('rejected without a reason', () => {
    expect(kycState({ ...storedSeller, kycStatus: 'REJECTED' })).toEqual({ key: 'rejected', reason: null });
  });
  test('PENDING with Aadhaar or PAN on file is waiting for review', () => {
    expect(kycState(storedSeller).key).toBe('pending');
  });
  test('PENDING with nothing on file has not started — it is the column default', () => {
    expect(kycState({ ...storedSeller, sellerProfile: { bankIfsc: 'SBIN0012345' } }).key).toBe('notStarted');
    expect(kycState({ kycStatus: 'PENDING', sellerProfile: null }).key).toBe('notStarted');
  });
  test('SUBMITTED is waiting for review', () => {
    expect(kycState({ kycStatus: 'SUBMITTED', sellerProfile: null }).key).toBe('pending');
  });
});

describe('completion', () => {
  test('a complete seller is 100% on both screens', () => {
    expect(completionFromUser(storedSeller)).toBe(100);
    expect(completionFromForm(initialFormFromUser(storedSeller), onFileFromUser(storedSeller))).toBe(100);
  });
  test('the masked account number counts only through onFile (the input is always blank)', () => {
    const form = initialFormFromUser(storedSeller);
    expect(form.bankAccountNumber).toBe('');
    expect(completionFromForm(form, {})).toBe(90);
  });
  test('opting out of GST counts as answering it', () => {
    expect(completionFromUser({ ...storedSeller, gstNumber: '', gstOptOut: true })).toBe(100);
  });
});

describe('initialFormFromUser', () => {
  test('encrypted fields start blank; plain ones are prefilled', () => {
    const form = initialFormFromUser(storedSeller);
    expect(form).toMatchObject({
      name: 'Shree Krushi Kendra',
      businessType: 'krushi_kendra',
      district: 'Pune',
      taluka: 'Haveli',
      gstOptOut: false,
      gstNumber: '27ABCDE1234F1Z0',
      bankIfsc: 'SBIN0012345',
      bankAccountNumber: '',
      aadharNumber: '',
      panNumber: '',
    });
  });
  test('a new seller has no business type chosen for them', () => {
    expect(initialFormFromUser({ role: 'FARMER', sellerProfile: null }).businessType).toBe('');
  });
  test('an unknown stored business type is not shown as selected', () => {
    expect(initialFormFromUser({ businessType: 'retired_value', sellerProfile: null }).businessType).toBe('');
  });
  test('no GST number on file starts as opted out', () => {
    expect(initialFormFromUser({ gstNumber: '', gstOptOut: false }).gstOptOut).toBe(true);
  });
});

describe('district and taluka', () => {
  test('renamed districts map to the name the picker lists', () => {
    expect(canonicalDistrict('Dharashiv')).toBe('Osmanabad');
    expect(canonicalDistrict('Chhatrapati Sambhajinagar')).toBe('Aurangabad');
    expect(canonicalDistrict('ahilyanagar')).toBe('Ahmednagar');
  });
  test('a district outside the list is dropped, not silently resubmitted', () => {
    expect(canonicalDistrict('Mumbai City')).toBe('');
    expect(canonicalDistrict('Belagavi')).toBe('');
    expect(canonicalDistrict('  pune ')).toBe('Pune');
  });
  test('a taluka must belong to the district', () => {
    expect(canonicalTaluka('Pune', 'haveli')).toBe('Haveli');
    expect(canonicalTaluka('Nashik', 'Haveli')).toBe('');
    expect(canonicalTaluka('', 'Haveli')).toBe('');
  });
  test('a stored location the picker cannot show starts empty', () => {
    const form = initialFormFromUser({ district: 'Mumbai City', taluka: 'Andheri', sellerProfile: null });
    expect(form.district).toBe('');
    expect(form.taluka).toBe('');
  });
});

describe('applyFieldChange', () => {
  const base = initialFormFromUser(storedSeller);

  test('a pasted Aadhaar with spaces keeps all 12 digits', () => {
    expect(applyFieldChange(base, 'aadharNumber', '2345 6789 0124').aadharNumber).toBe('234567890124');
  });
  test('extra digits are dropped', () => {
    expect(applyFieldChange(base, 'aadharNumber', '2345678901245').aadharNumber).toBe('234567890124');
    expect(applyFieldChange(base, 'bankAccountNumber', '1234-5678-9012-3456-789').bankAccountNumber)
      .toBe('123456789012345678');
  });
  test('PAN, IFSC and GST are uppercased and stripped of separators', () => {
    expect(applyFieldChange(base, 'panNumber', 'abcde 1234 f').panNumber).toBe('ABCDE1234F');
    expect(applyFieldChange(base, 'bankIfsc', 'sbin-0012345').bankIfsc).toBe('SBIN0012345');
    expect(applyFieldChange(base, 'gstNumber', '27 abcde 1234 f1z0').gstNumber).toBe('27ABCDE1234F1Z0');
  });
  test('changing district clears taluka; re-picking the same district does not', () => {
    expect(applyFieldChange(base, 'district', 'Nashik').taluka).toBe('');
    expect(applyFieldChange(base, 'district', 'Pune').taluka).toBe('Haveli');
  });
  test('ticking "no GST" clears the number, unticking brings back the stored one', () => {
    const ticked = applyFieldChange(base, 'gstOptOut', true);
    expect(ticked.gstNumber).toBe('');
    expect(applyFieldChange(ticked, 'gstOptOut', false, base).gstNumber).toBe('27ABCDE1234F1Z0');
  });
  test('clearing the account number clears its confirmation', () => {
    const typed = { ...base, bankAccountNumber: '123456789', bankAccountConfirm: '123456789' };
    expect(applyFieldChange(typed, 'bankAccountNumber', '').bankAccountConfirm).toBe('');
  });
});

describe('hasUnsavedChanges', () => {
  const base = initialFormFromUser(storedSeller);
  test('typing and then deleting is not a change', () => {
    expect(hasUnsavedChanges({ ...base, village: 'Wagholi ' }, base)).toBe(false);
  });
  test('a real edit is', () => {
    expect(hasUnsavedChanges({ ...base, village: 'Lonikand' }, base)).toBe(true);
    expect(hasUnsavedChanges({ ...base, gstOptOut: true }, base)).toBe(true);
    expect(hasUnsavedChanges({ ...base, aadharNumber: '2' }, base)).toBe(true);
  });
});

describe('validateBusinessProfile', () => {
  const onFile = onFileFromUser(storedSeller);

  test('a stored, complete seller passes untouched', () => {
    expect(validateBusinessProfile(initialFormFromUser(storedSeller), { onFile })).toEqual({});
  });

  test('a blank form reports every required field at once', () => {
    const errors = validateBusinessProfile(initialFormFromUser({ sellerProfile: null }));
    expect(Object.keys(errors).sort()).toEqual(['businessType', 'district', 'name', 'taluka', 'village']);
    expect(firstErrorKey(errors)).toBe('name');
  });

  test('a one-letter name is refused (the API needs two)', () => {
    expect(validateBusinessProfile({ ...validNewSeller, name: 'R' }).name).toBeTruthy();
  });

  test('a taluka from another district is refused', () => {
    expect(validateBusinessProfile({ ...validNewSeller, taluka: 'Niphad' }).taluka).toBeTruthy();
  });

  describe('GST', () => {
    test('unticked "no GST" needs a number', () => {
      expect(validateBusinessProfile({ ...validNewSeller, gstOptOut: false, gstNumber: '' }).gstNumber).toBeTruthy();
    });
    test('wrong shape and wrong check character are both caught', () => {
      const shape = validateBusinessProfile({ ...validNewSeller, gstOptOut: false, gstNumber: '27ABCDE1234F1Z' });
      const typo = validateBusinessProfile({ ...validNewSeller, gstOptOut: false, gstNumber: '27ABCDE1234F1Z5' });
      expect(shape.gstNumber).toMatch(/valid 15-character/);
      expect(typo.gstNumber).toMatch(/typo/);
    });
  });

  describe('bank', () => {
    test('a new account number must be 9–18 digits and typed twice', () => {
      expect(validateBusinessProfile({ ...validNewSeller, bankAccountNumber: '1234' }).bankAccountNumber).toBeTruthy();
      const mismatch = validateBusinessProfile({
        ...validNewSeller,
        bankAccountNumber: '123456789012',
        bankAccountConfirm: '123456789013',
        bankIfsc: 'SBIN0012345',
        bankHolderName: 'Ramesh Patil',
      });
      expect(mismatch).toEqual({ bankAccountConfirm: 'Account numbers do not match' });
    });

    test('an account — new or on file — needs an IFSC and a holder name', () => {
      const typed = validateBusinessProfile({
        ...validNewSeller, bankAccountNumber: '123456789012', bankAccountConfirm: '123456789012',
      });
      expect(Object.keys(typed).sort()).toEqual(['bankHolderName', 'bankIfsc']);

      const cleared = validateBusinessProfile(
        { ...initialFormFromUser(storedSeller), bankIfsc: '', bankHolderName: '' },
        { onFile },
      );
      expect(Object.keys(cleared).sort()).toEqual(['bankHolderName', 'bankIfsc']);
    });

    test('bank details without an account number ask for the number', () => {
      const errors = validateBusinessProfile({ ...validNewSeller, bankIfsc: 'SBIN0012345' });
      expect(errors.bankAccountNumber).toMatch(/account number/);
    });

    test('no bank details at all is allowed', () => {
      expect(validateBusinessProfile(validNewSeller)).toEqual({});
    });
  });

  describe('KYC', () => {
    test('Aadhaar: length, then check digit', () => {
      expect(validateBusinessProfile({ ...validNewSeller, aadharNumber: '23456789' }).aadharNumber).toMatch(/12 digits/);
      expect(validateBusinessProfile({ ...validNewSeller, aadharNumber: '234567890125' }).aadharNumber).toMatch(/not valid/);
      expect(validateBusinessProfile({ ...validNewSeller, aadharNumber: '234567890124' })).toEqual({});
    });
    test('PAN format', () => {
      expect(validateBusinessProfile({ ...validNewSeller, panNumber: 'ABCDE12345' }).panNumber).toBeTruthy();
      expect(validateBusinessProfile({ ...validNewSeller, panNumber: 'ABCDE1234F' })).toEqual({});
    });
  });

  test('messages come from t()', () => {
    const t = (key) => `«${key}»`;
    expect(validateBusinessProfile({ ...validNewSeller, name: '' }, { t }).name).toBe('«sellerBizProfile.nameRequired»');
  });
});

describe('buildBusinessProfilePayload', () => {
  test('an unchanged seller sends no sensitive field (so no PII budget is used)', () => {
    const payload = buildBusinessProfilePayload({ ...initialFormFromUser(storedSeller), village: 'Lonikand' }, storedSeller);
    expect(payload).toEqual({
      sellerConsent: true,
      businessType: 'krushi_kendra',
      district: 'Pune',
      taluka: 'Haveli',
      village: 'Lonikand',
      state: 'Maharashtra',
      gstOptOut: false,
    });
  });

  test('only the bank field that changed is sent', () => {
    const payload = buildBusinessProfilePayload(
      { ...initialFormFromUser(storedSeller), bankIfsc: 'HDFC0001234' },
      storedSeller,
    );
    expect(payload.bankIfsc).toBe('HDFC0001234');
    expect(payload).not.toHaveProperty('bankHolderName');
    expect(payload).not.toHaveProperty('bankName');
    expect(payload).not.toHaveProperty('gstNumber');
  });

  test('a first save sends empty bank fields so the seller profile row is created', () => {
    const payload = buildBusinessProfilePayload(validNewSeller, { role: 'FARMER', sellerProfile: null });
    expect(payload).toMatchObject({ bankHolderName: '', bankName: '', bankIfsc: '', gstNumber: '', name: 'Ramesh Patil' });
  });

  test('encrypted fields are sent only when typed, never as blanks', () => {
    const untouched = buildBusinessProfilePayload(initialFormFromUser(storedSeller), storedSeller);
    expect(untouched).not.toHaveProperty('aadharNumber');
    expect(untouched).not.toHaveProperty('panNumber');
    expect(untouched).not.toHaveProperty('bankAccountNumber');

    const typed = buildBusinessProfilePayload(
      { ...initialFormFromUser(storedSeller), aadharNumber: '234567890124', panNumber: 'abcde1234f', bankAccountNumber: '123456789' },
      storedSeller,
    );
    expect(typed).toMatchObject({ aadharNumber: '234567890124', panNumber: 'ABCDE1234F', bankAccountNumber: '123456789' });
    expect(typed).not.toHaveProperty('bankAccountConfirm');
  });

  test('opting out clears a stored GST number', () => {
    const form = applyFieldChange(initialFormFromUser(storedSeller), 'gstOptOut', true);
    expect(buildBusinessProfilePayload(form, storedSeller)).toMatchObject({ gstOptOut: true, gstNumber: '' });
  });

  test('the name is sent only when it changed', () => {
    expect(buildBusinessProfilePayload(initialFormFromUser(storedSeller), storedSeller)).not.toHaveProperty('name');
    expect(buildBusinessProfilePayload({ ...initialFormFromUser(storedSeller), name: 'Patil Agro' }, storedSeller).name)
      .toBe('Patil Agro');
  });
});

describe('server field errors', () => {
  const badRequest = (details) => ({ response: { status: 400, data: { error: { message: 'x', details } } } });

  test('maps validator paths to form fields', () => {
    const error = badRequest([
      { path: 'bankIfsc', msg: 'IFSC must be 11 characters' },
      { path: 'aadharNumber', msg: 'Aadhaar must be exactly 12 digits' },
      { path: 'bankIfsc', msg: 'Invalid value' },
      { path: 'sellerConsent', msg: 'Invalid value' },
    ]);
    expect(serverFieldErrorKeys(error)).toEqual(['bankIfsc', 'aadharNumber']);
  });

  test('ignores anything that is not a 400 with details', () => {
    expect(serverFieldErrorKeys({ response: { status: 429, data: {} } })).toEqual([]);
    expect(serverFieldErrorKeys(badRequest(undefined))).toEqual([]);
    expect(serverFieldErrorKeys(new Error('Network Error'))).toEqual([]);
  });

  test('every mapped field has a message', () => {
    expect(serverFieldMessage('bankIfsc')).toMatch(/IFSC/);
    expect(serverFieldMessage('bankHolderName')).toBe('Please check this field');
  });
});
