import {
  AREA_KINDS, areaKind, areaLabel, buildAreaPayload, cleanDigits, emptyAreaForm, etaLabel,
  formFromArea, nextFormAfterSave, sortAreas, upsertArea, validateAreaForm,
} from '../deliveryAreas';

// LanguageContext's t(), for keys that are not translated yet: a string second
// argument is the fallback, an object carries vars plus `defaultValue`.
const t = (key, arg) => {
  if (typeof arg === 'string') return arg;
  const template = arg?.defaultValue ?? key;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(arg?.[k] ?? ''));
};

const valid = (over = {}) => ({ ...emptyAreaForm('413102'), ...over });

describe('AREA_KINDS — what the form offers', () => {
  test('only the kinds the backend can match from a PIN code', () => {
    // A district rule is never applied to a quote (see the comment on
    // AREA_KINDS), so it is not offered until the backend can match one.
    expect(AREA_KINDS).toEqual(['PIN', 'PREFIX']);
  });

  test('a saved district or state row can still be shown, edited and re-saved', () => {
    const district = { id: 'd1', district: 'Solapur', etaMinDays: 1, etaMaxDays: 3, surcharge: '0.00' };
    expect(areaLabel(district, t)).toBe('Solapur district');
    const form = { ...formFromArea(district), etaMaxDays: '4' };
    expect(validateAreaForm(form, t)).toEqual({});
    expect(buildAreaPayload(form)).toMatchObject({ district: 'Solapur', etaMaxDays: 4 });

    const state = formFromArea({ id: 's1', state: 'Maharashtra', etaMinDays: 2, etaMaxDays: 6 });
    expect(validateAreaForm(state, t)).toEqual({});
    expect(buildAreaPayload(state)).toMatchObject({ state: 'Maharashtra' });
  });
});

describe('areaKind / areaLabel', () => {
  test('ranks a row by the most specific thing it covers', () => {
    expect(areaKind({ pincode: '413102' })).toBe('PIN');
    expect(areaKind({ pincodePrefix: '413' })).toBe('PREFIX');
    expect(areaKind({ district: 'Solapur', state: 'Maharashtra' })).toBe('DISTRICT');
    expect(areaKind({ state: 'Maharashtra' })).toBe('STATE');
    expect(areaKind({})).toBeNull();
  });

  test('names the area in words a seller would use', () => {
    expect(areaLabel({ pincode: '413102' }, t)).toBe('PIN 413102');
    expect(areaLabel({ pincodePrefix: '413' }, t)).toBe('PIN codes starting 413');
    expect(areaLabel({ district: 'Solapur' }, t)).toBe('Solapur district');
    expect(areaLabel({ state: 'Maharashtra' }, t)).toBe('Maharashtra');
  });
});

describe('etaLabel', () => {
  test('reads as a delivery promise, not as two numbers', () => {
    expect(etaLabel(0, 0, t)).toBe('Same day');
    expect(etaLabel(1, 1, t)).toBe('1 day');
    expect(etaLabel(3, 3, t)).toBe('3 days');
    expect(etaLabel(1, 2, t)).toBe('1–2 days');
    expect(etaLabel(0, 1, t)).toBe('0–1 days');
  });

  test('a row with no estimate does not print NaN or a false "Same day"', () => {
    expect(etaLabel(undefined, undefined, t)).toBe('—');
    expect(etaLabel(null, null, t)).toBe('—');
  });
});

describe('emptyAreaForm', () => {
  test('starts on the seller\'s own PIN code when it is a real one', () => {
    expect(emptyAreaForm('413102').pincode).toBe('413102');
    expect(emptyAreaForm(' 413 102 ').pincode).toBe('413102');
  });

  test('starts blank for a missing or malformed PIN code', () => {
    expect(emptyAreaForm(null).pincode).toBe('');
    expect(emptyAreaForm('012345').pincode).toBe('');
    expect(emptyAreaForm('4131').pincode).toBe('');
  });
});

describe('validateAreaForm', () => {
  test('a pre-filled form is sendable as it stands', () => {
    expect(validateAreaForm(valid(), t)).toEqual({});
  });

  test('only the field for the chosen kind is required', () => {
    expect(validateAreaForm(valid({ kind: 'PIN', pincode: '41310' }), t)).toHaveProperty('pincode');
    expect(validateAreaForm(valid({ kind: 'PIN', pincode: '013102' }), t)).toHaveProperty('pincode');
    expect(validateAreaForm(valid({ kind: 'PREFIX', pincode: '', pincodePrefix: '413' }), t)).toEqual({});
    expect(validateAreaForm(valid({ kind: 'PREFIX', pincodePrefix: '41' }), t)).toHaveProperty('pincodePrefix');
    expect(validateAreaForm(valid({ kind: 'DISTRICT', pincode: '', district: '' }), t)).toHaveProperty('district');
    expect(validateAreaForm(valid({ kind: 'DISTRICT', pincode: '', district: 'Solapur' }), t)).toEqual({});
  });

  test('days must be whole numbers the server accepts', () => {
    expect(validateAreaForm(valid({ etaMinDays: '' }), t)).toHaveProperty('etaMinDays');
    expect(validateAreaForm(valid({ etaMaxDays: '1.5' }), t)).toHaveProperty('etaMaxDays');
    expect(validateAreaForm(valid({ etaMaxDays: '91' }), t)).toHaveProperty('etaMaxDays');
    expect(validateAreaForm(valid({ etaMinDays: '0', etaMaxDays: '0' }), t)).toEqual({});
  });

  test('the slowest time cannot be earlier than the fastest', () => {
    const errors = validateAreaForm(valid({ etaMinDays: '3', etaMaxDays: '2' }), t);
    expect(errors.etaMaxDays).toBe('The slowest time cannot be less than the fastest.');
    expect(errors).not.toHaveProperty('etaMinDays');
  });

  test('the extra charge is optional, and a number when given', () => {
    expect(validateAreaForm(valid({ surcharge: '' }), t)).toEqual({});
    expect(validateAreaForm(valid({ surcharge: '30' }), t)).toEqual({});
    expect(validateAreaForm(valid({ surcharge: '30.50' }), t)).toEqual({});
    expect(validateAreaForm(valid({ surcharge: '-5' }), t)).toHaveProperty('surcharge');
    expect(validateAreaForm(valid({ surcharge: '30.555' }), t)).toHaveProperty('surcharge');
    expect(validateAreaForm(valid({ surcharge: '100001' }), t)).toHaveProperty('surcharge');
  });
});

describe('buildAreaPayload', () => {
  test('sends exactly one area key, the one for the chosen kind', () => {
    expect(buildAreaPayload(valid({ surcharge: '30' }))).toEqual({
      pincode: '413102', etaMinDays: 1, etaMaxDays: 2, surcharge: 30,
      codAvailable: true, pickupAvailable: false,
    });
    // A value typed under another kind before switching is not sent.
    const prefix = buildAreaPayload(valid({ kind: 'PREFIX', pincodePrefix: '413' }));
    expect(prefix).toMatchObject({ pincodePrefix: '413' });
    expect(prefix).not.toHaveProperty('pincode');
    expect(buildAreaPayload(valid({ kind: 'DISTRICT', district: ' Solapur ' }))).toMatchObject({ district: 'Solapur' });
  });

  test('an empty extra charge is sent as zero, not as NaN', () => {
    expect(buildAreaPayload(valid({ surcharge: '' })).surcharge).toBe(0);
  });

  test('never sends a field the route refuses', () => {
    const body = buildAreaPayload(formFromArea({ id: 'a1', sellerId: 's1', pincode: '413102', etaMinDays: 1, etaMaxDays: 2 }));
    for (const k of ['id', 'sellerId', 'status', 'kind']) expect(body).not.toHaveProperty(k);
  });
});

describe('formFromArea', () => {
  test('editing keeps the COD and pickup settings the screen does not show', () => {
    const row = {
      id: 'a1', pincodePrefix: '413', etaMinDays: 2, etaMaxDays: 5, surcharge: '40.00',
      codAvailable: false, pickupAvailable: true,
    };
    const form = formFromArea(row);
    expect(form).toMatchObject({ id: 'a1', kind: 'PREFIX', pincodePrefix: '413', etaMinDays: '2', etaMaxDays: '5', surcharge: '40' });
    expect(buildAreaPayload(form)).toMatchObject({ codAvailable: false, pickupAvailable: true });
  });

  test('a zero charge shows as an empty field', () => {
    expect(formFromArea({ pincode: '413102', surcharge: '0.00' }).surcharge).toBe('');
  });
});

describe('nextFormAfterSave', () => {
  test('after adding, keeps the times and charge and clears only the area', () => {
    const next = nextFormAfterSave(valid({ kind: 'PIN', etaMinDays: '0', etaMaxDays: '1', surcharge: '30' }));
    expect(next).toMatchObject({ id: null, kind: 'PIN', pincode: '', etaMinDays: '0', etaMaxDays: '1', surcharge: '30' });
  });

  test('after editing, goes back to a blank form', () => {
    const next = nextFormAfterSave(formFromArea({ id: 'a1', pincodePrefix: '413', etaMinDays: 4, etaMaxDays: 6, surcharge: '80.00' }));
    expect(next).toEqual(emptyAreaForm(''));
  });
});

describe('sortAreas / upsertArea', () => {
  const pin = { id: '1', pincode: '413102' };
  const prefix = { id: '2', pincodePrefix: '413' };
  const district = { id: '3', district: 'Solapur' };

  test('lists the most specific rule first', () => {
    expect(sortAreas([district, prefix, pin]).map((a) => a.id)).toEqual(['1', '2', '3']);
    expect(sortAreas([{ id: 'b', pincode: '413102' }, { id: 'a', pincode: '411001' }]).map((a) => a.id)).toEqual(['a', 'b']);
  });

  test('a saved row replaces the one with its id instead of appearing twice', () => {
    const next = upsertArea([pin, prefix], { ...pin, etaMaxDays: 9 });
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ id: '1', etaMaxDays: 9 });
  });

  test('a new row is added in order, and a response without an id changes nothing', () => {
    expect(upsertArea([district], pin).map((a) => a.id)).toEqual(['1', '3']);
    expect(upsertArea([pin], null)).toEqual([pin]);
  });
});

describe('cleanDigits', () => {
  test('keeps digits only, up to the cap', () => {
    expect(cleanDigits('413 102', 6)).toBe('413102');
    expect(cleanDigits('4131029', 6)).toBe('413102');
    expect(cleanDigits(null, 6)).toBe('');
  });
});
