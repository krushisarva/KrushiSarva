/**
 * Add-product form logic — no React, no React Native.
 *
 * AddProductScreen reads this, which is what lets frontend/jest.config.js test
 * the rules without a renderer.
 *
 * The limits are the API's (backend/src/routes/agristore.routes.js:
 * LISTING_FIELDS and PRODUCT_TEXT_LIMITS). The form used to accept values the
 * server rejects — 90 dispatch days, ₹0.005, a 41-character harvest date, stock
 * past the Postgres integer — so the save failed with a generic "Invalid
 * request" toast and no field highlighted, or with a 500 for the overflow.
 */

/** sellingPrice isFloat({ min: 0.01 }). */
export const PRICE_MIN = 0.01;
/** Sanity ceiling for price and MRP. The column holds more; no real listing does. */
export const PRICE_MAX = 10_000_000;
/** Postgres `integer`: a larger stock or minimum order is a 500, not a 400. */
export const INT_MAX = 2_147_483_647;
/** dispatchSlaDays isInt({ min: 0, max: 60 }). */
export const DISPATCH_SLA_MAX = 60;

/** The API's length limits for the free-text fields on this form. */
export const TEXT_MAX = {
  brand: 100,
  manufacturer: 120,
  countryOfOrigin: 80,
  sellerSku: 80,
  harvestDate: 40,
  village: 120,
};

/** Form keys in the order the screen shows them; the first error is scrolled to. */
export const FIELD_ORDER = [
  'categoryId', 'name', 'price', 'mrp', 'stock', 'moq', 'dispatchSla', 'sellerSku',
  'harvestDate', 'brand', 'manufacturer', 'countryOfOrigin', 'district', 'village',
];

/** A `t` for tests and defaults: the fallback text with {{vars}} filled in, else the key. */
const passthroughT = (key, fallback) => {
  const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue;
  if (typeof text !== 'string') return key;
  if (typeof fallback !== 'object') return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(fallback[k] ?? ''));
};

const clean = (v) => String(v ?? '').trim();

const tooLong = (t, max) => t('products.tooLong', { max, defaultValue: 'Use at most {{max}} characters.' });

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Pure: form values in, `{ field: message }` out. Every rule fires on the same
 * pass — the old sequential Alerts stopped at the first failure, so a seller
 * with three problems had to submit three times to find them all.
 */
export function validateProductForm(form, t = passthroughT, mode = 'create') {
  const errors = {};

  // In `attach` and `edit` the catalog row supplies the category, the name and
  // the brand. Checking them here would make an otherwise-valid offer
  // unsubmittable, since none of those fields is rendered in those modes.
  if (mode === 'create') {
    if (!form.categoryId) {
      errors.categoryId = t('products.selectCategoryMsg');
    }

    const name = clean(form.name);
    if (!name) errors.name = t('products.productNameRequired');
    else if (name.length < 3) {
      errors.name = t('products.nameTooShort', 'Use at least 3 characters so buyers can find it.');
    }

    ['brand', 'manufacturer', 'countryOfOrigin'].forEach((k) => {
      if (clean(form[k]).length > TEXT_MAX[k]) errors[k] = tooLong(t, TEXT_MAX[k]);
    });
  }

  const price = Number(form.price);
  if (!clean(form.price)) errors.price = t('products.validPrice');
  else if (!Number.isFinite(price) || price < PRICE_MIN) errors.price = t('products.validPrice');
  else if (price > PRICE_MAX) {
    errors.price = t('products.priceTooHigh', 'That price looks wrong. Please check it.');
  }

  if (clean(form.mrp)) {
    const mrp = Number(form.mrp);
    if (!Number.isFinite(mrp) || mrp < 0) {
      errors.mrp = t('products.validMrp', 'Enter a valid MRP, or leave it blank.');
    } else if (mrp > PRICE_MAX) {
      errors.mrp = t('products.priceTooHigh', 'That price looks wrong. Please check it.');
    } else if (Number.isFinite(price) && mrp > 0 && mrp < price) {
      // Selling above MRP is not legal retail practice, and buyers see the
      // strikethrough as an increase — worth catching before it goes live.
      errors.mrp = t('products.mrpBelowPrice', 'MRP cannot be less than your selling price.');
    }
  }

  const stock = Number(form.stock);
  if (!clean(form.stock)) errors.stock = t('products.validStock');
  else if (!Number.isFinite(stock) || stock < 0) errors.stock = t('products.validStock');
  else if (!Number.isInteger(stock)) {
    errors.stock = t('products.stockWhole', 'Stock must be a whole number.');
  } else if (stock > INT_MAX) {
    errors.stock = t('products.numberTooLarge', 'That number is too large. Please check it.');
  }

  if (clean(form.moq)) {
    const moq = Number(form.moq);
    if (!Number.isFinite(moq) || moq < 1 || !Number.isInteger(moq)) {
      errors.moq = t('products.validMoq', 'Minimum order must be a whole number of 1 or more.');
    } else if (moq > INT_MAX) {
      errors.moq = t('products.numberTooLarge', 'That number is too large. Please check it.');
    } else if (Number.isFinite(stock) && stock > 0 && moq > stock) {
      errors.moq = t('products.moqOverStock', 'Minimum order cannot be more than your stock.');
    }
  }

  // Blank means the default (2 days); anything typed must be what the API takes.
  if (clean(form.dispatchSla)) {
    const days = Number(form.dispatchSla);
    if (!Number.isInteger(days) || days < 0 || days > DISPATCH_SLA_MAX) {
      errors.dispatchSla = t('products.validDispatchSla', 'Enter whole days from 0 to 60.');
    }
  }

  ['sellerSku', 'harvestDate', 'village'].forEach((k) => {
    if (clean(form[k]).length > TEXT_MAX[k]) errors[k] = tooLong(t, TEXT_MAX[k]);
  });

  if (!form.district) errors.district = t('products.selectDistrictMsg');

  return errors;
}

/** The first field, in screen order, that has an error. */
export function firstErrorKey(errors) {
  return FIELD_ORDER.find((k) => errors?.[k]);
}

/** Client errors win; a server error shows until the seller edits that field. */
export function mergeFieldErrors(client, server) {
  const out = {};
  Object.keys(server || {}).forEach((k) => { if (server[k]) out[k] = server[k]; });
  Object.keys(client || {}).forEach((k) => { if (client[k]) out[k] = client[k]; });
  return out;
}

// ── Server rejections ────────────────────────────────────────────────────────

/** API field (validator `path`) → form key. `price`/`stock` are the legacy edit's names. */
const SERVER_FIELD_KEYS = {
  sellingPrice: 'price', price: 'price', mrp: 'mrp',
  stockQty: 'stock', stock: 'stock', expectedStockQty: 'stock',
  minOrderQty: 'moq', dispatchSlaDays: 'dispatchSla',
  sellerSku: 'sellerSku', harvestDate: 'harvestDate',
  district: 'district', village: 'village',
  categoryId: 'categoryId', name: 'name',
  brand: 'brand', manufacturer: 'manufacturer', countryOfOrigin: 'countryOfOrigin',
};

function serverFieldMessage(key, t) {
  if (TEXT_MAX[key]) return tooLong(t, TEXT_MAX[key]);
  switch (key) {
    case 'price': return t('products.validPrice');
    case 'mrp': return t('products.validMrp', 'Enter a valid MRP, or leave it blank.');
    case 'stock': return t('products.validStock');
    case 'moq': return t('products.validMoq', 'Minimum order must be a whole number of 1 or more.');
    case 'dispatchSla': return t('products.validDispatchSla', 'Enter whole days from 0 to 60.');
    case 'district': return t('products.selectDistrictMsg');
    case 'categoryId': return t('products.selectCategoryMsg');
    default: return t('products.checkField', 'Please check this field.');
  }
}

/**
 * `{ formKey: message }` for the fields a 400 from the validator middleware
 * names (error.details is express-validator's array, `path` per entry). Empty
 * for any other failure, which the screen reports as a toast.
 */
export function serverFieldErrors(error, t = passthroughT) {
  if (error?.response?.status !== 400) return {};
  const details = error.response.data?.error?.details;
  if (!Array.isArray(details)) return {};
  const out = {};
  details.forEach((d) => {
    const key = SERVER_FIELD_KEYS[d?.path ?? d?.param];
    if (key && !out[key]) out[key] = serverFieldMessage(key, t);
  });
  return out;
}

// ── Attaching instead of creating ────────────────────────────────────────────

/**
 * AddProduct's attach-mode params for a catalog product and one of its packs, in
 * the shape Catalog Search sends.
 */
export function attachParams(product, variant) {
  return {
    intent: 'attach',
    catalogProduct: {
      id: product.id, name: product.name, brand: product.brand,
      manufacturer: product.manufacturer, images: product.images,
      categoryId: product.categoryId, status: product.status,
    },
    variant: {
      id: variant.id,
      unit: variant.unit,
      packSize: variant.attributes?.packSize || null,
      lowestPrice: variant.lowestPrice ?? null,
      offerCount: variant.offerCount ?? 0,
    },
  };
}

/**
 * Where a create the duplicate gate refused (409) should attach instead: the
 * product the server named, in the pack the seller chose.
 *
 * `details.productId` names the product; `candidates` is only there to show it,
 * and its order is not the server's choice. The pack is the one with the form's
 * unit — narrowed by pack size when several share the unit, since the form
 * creates `{ packSize: unit }`. When no single pack matches, `variant` is null
 * and the seller picks in Catalog Search: guessing put a ₹266 bag price on the
 * 1 kg pack.
 *
 * @returns {{ product: ?object, variant: ?object }}
 */
export function pickAttachTarget(details, unit) {
  const product = (details?.candidates || []).find((c) => c?.id === details?.productId) || null;
  if (!product) return { product: null, variant: null };
  let matches = (product.variants || []).filter((v) => v?.unit === unit);
  if (matches.length > 1) matches = matches.filter((v) => (v.attributes?.packSize ?? v.unit) === unit);
  return { product, variant: matches.length === 1 ? matches[0] : null };
}

/**
 * The offer the seller typed, as a listing-shaped route param, so switching to
 * attach mode keeps it. `images` are already-uploaded URLs.
 */
export function carriedOffer(form, images = []) {
  return {
    sellingPrice: form.price,
    mrp: form.mrp,
    stockQty: form.stock,
    minOrderQty: form.moq,
    dispatchSlaDays: form.dispatchSla,
    sellerSku: form.sellerSku,
    sellScope: form.sellScope,
    district: form.district,
    taluka: form.taluka,
    village: form.village,
    state: form.state,
    harvestDate: form.harvestDate,
    images,
  };
}
