import {
  attachParams, carriedOffer, DISPATCH_SLA_MAX, firstErrorKey, INT_MAX, mergeFieldErrors,
  pickAttachTarget, PRICE_MIN, serverFieldErrors, TEXT_MAX, validateProductForm,
} from '../productForm';

// A complete, valid create form — each test breaks one thing.
const valid = {
  categoryId: 'cat-1', name: 'Urea Neem Coated', price: '266', mrp: '', unit: 'bag',
  stock: '40', moq: '1', dispatchSla: '2', sellerSku: '', harvestDate: '', village: '',
  brand: 'IFFCO', manufacturer: '', countryOfOrigin: 'India', district: 'Pune',
  taluka: 'Junnar', state: 'Maharashtra', sellScope: 'district',
};
const errorsFor = (patch, mode = 'create') => validateProductForm({ ...valid, ...patch }, undefined, mode);

describe('validateProductForm — mirrors the API (LISTING_FIELDS, PRODUCT_TEXT_LIMITS)', () => {
  test('a complete form has no errors', () => {
    expect(errorsFor({})).toEqual({});
  });

  test('dispatch days: whole numbers 0–60; blank means the default', () => {
    expect(errorsFor({ dispatchSla: '90' }).dispatchSla).toBeTruthy();
    expect(errorsFor({ dispatchSla: String(DISPATCH_SLA_MAX + 1) }).dispatchSla).toBeTruthy();
    expect(errorsFor({ dispatchSla: '2.5' }).dispatchSla).toBeTruthy();
    expect(errorsFor({ dispatchSla: '-1' }).dispatchSla).toBeTruthy();
    expect(errorsFor({ dispatchSla: 'abc' }).dispatchSla).toBeTruthy();
    expect(errorsFor({ dispatchSla: '0' }).dispatchSla).toBeUndefined();
    expect(errorsFor({ dispatchSla: '60' }).dispatchSla).toBeUndefined();
    expect(errorsFor({ dispatchSla: '' }).dispatchSla).toBeUndefined();
  });

  test('price: at least ₹0.01', () => {
    expect(errorsFor({ price: '0.005' }).price).toBeTruthy();
    expect(errorsFor({ price: '0' }).price).toBeTruthy();
    expect(errorsFor({ price: String(PRICE_MIN) }).price).toBeUndefined();
  });

  test('stock and minimum order must fit a Postgres integer', () => {
    expect(errorsFor({ stock: String(INT_MAX + 1) }).stock).toBeTruthy();
    expect(errorsFor({ stock: String(INT_MAX), moq: '1' }).stock).toBeUndefined();
    // Stock 0 skips the "MOQ above stock" rule, so the ceiling must catch this.
    expect(errorsFor({ stock: '0', moq: String(INT_MAX + 1) }).moq).toBeTruthy();
    expect(errorsFor({ stock: '0', moq: String(INT_MAX) }).moq).toBeUndefined();
  });

  test('MRP past the price ceiling is an error, not a 500', () => {
    expect(errorsFor({ mrp: '1e12' }).mrp).toBeTruthy();
  });

  test('text limits: harvest date 40, village 120, stock code 80', () => {
    expect(errorsFor({ harvestDate: 'x'.repeat(41) }).harvestDate).toBe('Use at most 40 characters.');
    expect(errorsFor({ harvestDate: 'x'.repeat(40) }).harvestDate).toBeUndefined();
    expect(errorsFor({ village: 'x'.repeat(TEXT_MAX.village + 1) }).village).toBeTruthy();
    expect(errorsFor({ sellerSku: 'x'.repeat(TEXT_MAX.sellerSku + 1) }).sellerSku).toBeTruthy();
    // Measured after trimming, as the server does.
    expect(errorsFor({ harvestDate: ` ${'x'.repeat(40)} ` }).harvestDate).toBeUndefined();
  });

  test('catalog text limits apply only when creating (the fields are not sent otherwise)', () => {
    const long = { brand: 'x'.repeat(TEXT_MAX.brand + 1), manufacturer: 'x'.repeat(TEXT_MAX.manufacturer + 1) };
    expect(Object.keys(errorsFor(long))).toEqual(expect.arrayContaining(['brand', 'manufacturer']));
    expect(errorsFor(long, 'attach')).toEqual({});
  });

  test('attach and edit do not require the catalog fields', () => {
    expect(errorsFor({ categoryId: '', name: '' }, 'attach')).toEqual({});
    expect(errorsFor({ categoryId: '', name: '' }, 'create')).toMatchObject({
      categoryId: expect.any(String), name: expect.any(String),
    });
  });
});

describe('firstErrorKey / mergeFieldErrors', () => {
  test('the first error in screen order', () => {
    expect(firstErrorKey({ district: 'x', dispatchSla: 'y' })).toBe('dispatchSla');
    expect(firstErrorKey({ village: 'x' })).toBe('village');
    expect(firstErrorKey({ price: undefined })).toBeUndefined();
  });

  test('a client error wins; a cleared one lets the server error show', () => {
    expect(mergeFieldErrors({ price: 'client', stock: undefined }, { price: 'server', stock: 'server' }))
      .toEqual({ price: 'client', stock: 'server' });
  });
});

describe('serverFieldErrors — a 400 lands on the fields it names', () => {
  const rejection = (details, status = 400) => ({ response: { status, data: { error: { message: 'x', details } } } });

  test('maps API field names to form keys', () => {
    const errs = serverFieldErrors(rejection([
      { type: 'field', path: 'dispatchSlaDays', msg: 'Invalid value' },
      { type: 'field', path: 'sellingPrice', msg: 'Invalid value' },
      { type: 'field', path: 'harvestDate', msg: 'harvestDate must be at most 40 characters' },
      { type: 'field', path: 'variants[0].gtin', msg: 'Invalid value' },
    ]));
    expect(errs).toEqual({
      dispatchSla: 'Enter whole days from 0 to 60.',
      price: 'products.validPrice',
      harvestDate: 'Use at most 40 characters.',
    });
  });

  test('nothing for other failures', () => {
    expect(serverFieldErrors(rejection([{ path: 'price' }], 409))).toEqual({});
    expect(serverFieldErrors(rejection(undefined))).toEqual({});
    expect(serverFieldErrors({ code: 'ECONNABORTED' })).toEqual({});
  });
});

describe('pickAttachTarget — the product the 409 names, in the seller\'s pack', () => {
  const urea = {
    id: 'urea', name: 'Urea',
    variants: [
      { id: 'urea-kg', unit: 'kg', attributes: { packSize: '1kg' } },
      { id: 'urea-bag', unit: 'bag', attributes: { packSize: '45kg' } },
    ],
  };
  const other = { id: 'other', name: 'Urea 46%', variants: [{ id: 'other-bag', unit: 'bag' }] };

  test('picks by productId, not position, and by unit, not the first pack', () => {
    const { product, variant } = pickAttachTarget({ productId: 'urea', candidates: [other, urea] }, 'bag');
    expect(product.id).toBe('urea');
    expect(variant.id).toBe('urea-bag');
  });

  test('no pack in that unit → no variant (the seller picks in Catalog Search)', () => {
    expect(pickAttachTarget({ productId: 'urea', candidates: [urea] }, 'litre').variant).toBeNull();
  });

  test('several packs in that unit: the one shaped like the form\'s, else none', () => {
    const bags = {
      id: 'dap', variants: [
        { id: 'dap-50', unit: 'bag', attributes: { packSize: '50kg' } },
        { id: 'dap-bag', unit: 'bag', attributes: { packSize: 'bag' } },
      ],
    };
    expect(pickAttachTarget({ productId: 'dap', candidates: [bags] }, 'bag').variant.id).toBe('dap-bag');
    const ambiguous = { id: 'dap', variants: bags.variants.slice(0, 1).concat({ id: 'dap-45', unit: 'bag', attributes: { packSize: '45kg' } }) };
    expect(pickAttachTarget({ productId: 'dap', candidates: [ambiguous] }, 'bag').variant).toBeNull();
  });

  test('a productId missing from the candidates → nothing', () => {
    expect(pickAttachTarget({ productId: 'gone', candidates: [urea] }, 'bag')).toEqual({ product: null, variant: null });
  });
});

describe('attachParams / carriedOffer', () => {
  test('attach params in the shape Catalog Search sends', () => {
    const p = attachParams(
      { id: 'p1', name: 'Urea', brand: 'IFFCO', images: ['a.jpg'], categoryId: 'c', status: 'PENDING_QC', variants: [] },
      { id: 'v1', unit: 'bag', attributes: { packSize: '45kg' }, offerCount: 2, lowestPrice: '250.00' },
    );
    expect(p).toEqual({
      intent: 'attach',
      catalogProduct: {
        id: 'p1', name: 'Urea', brand: 'IFFCO', manufacturer: undefined, images: ['a.jpg'],
        categoryId: 'c', status: 'PENDING_QC',
      },
      variant: { id: 'v1', unit: 'bag', packSize: '45kg', lowestPrice: '250.00', offerCount: 2 },
    });
  });

  test('the typed offer is carried with its photos', () => {
    const offer = carriedOffer({ ...valid, mrp: '300', village: 'Narayangaon', harvestDate: 'Ready now' }, ['u.jpg']);
    expect(offer).toMatchObject({
      sellingPrice: '266', mrp: '300', stockQty: '40', minOrderQty: '1', dispatchSlaDays: '2',
      district: 'Pune', taluka: 'Junnar', village: 'Narayangaon', harvestDate: 'Ready now',
      sellScope: 'district', state: 'Maharashtra', images: ['u.jpg'],
    });
  });
});
