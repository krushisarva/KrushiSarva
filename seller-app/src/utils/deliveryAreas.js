/**
 * Delivery-area form logic — no React, no React Native.
 *
 * A seller's delivery areas are SellerServiceArea rows, written through
 * /agristore/seller-compliance/service-areas (backend
 * routes/sellerCompliance.routes.js). The backend has resolved them at quote
 * time since the PIN-serviceability work — the ETA is shown to the farmer and
 * frozen on the order, the surcharge is added to that seller's delivery fee —
 * but no screen wrote them, so every Kendra was "delivers everywhere, platform
 * default estimate".
 *
 * The rules below mirror that route's validators, so a bad value earns a field
 * error here instead of a generic 400 from the server.
 */

/**
 * What the form OFFERS for a new area. Rows of every kind are still displayed,
 * and their time and charge can be changed or the row removed.
 *
 * DISTRICT (and STATE) are not offered, because the backend cannot match them.
 * Both callers of resolveServiceability() — the cart quote in
 * shopPricing.service.js and the product-page PIN check — hold a PIN code and
 * nothing else, there is no PIN → district table to derive one from, and
 * pickRow() only compares a district row against a district it was given. So
 * the days and the charge on a "whole district" rule are never applied to any
 * farmer's quote: the seller would save it, see it listed here, and be quoted
 * to farmers exactly as before.
 *
 * A switch that changes nothing is worse than no switch. Add 'DISTRICT' back
 * here once the backend resolves the buyer's district from the PIN code — the
 * screen's district picker, the validation and the payload are all still in
 * place and tested.
 */
export const AREA_KINDS = ['PIN', 'PREFIX'];

export const ETA_MAX_DAYS = 90;
export const SURCHARGE_MAX = 100000;

// Same shapes as isValidPincode() and the prefix check in the route.
const PIN_RE = /^[1-9][0-9]{5}$/;
const PREFIX_RE = /^[1-9][0-9]{2}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

const str = (v) => (v == null ? '' : String(v).trim());

/** Digits only, capped — what a PIN or day-count field keeps after a paste. */
export function cleanDigits(value, max) {
  return str(value).replace(/\D/g, '').slice(0, max);
}

/** Which kind of area a saved row covers. Most specific first, as the server ranks them. */
export function areaKind(area) {
  if (area?.pincode) return 'PIN';
  if (area?.pincodePrefix) return 'PREFIX';
  if (area?.district) return 'DISTRICT';
  if (area?.state) return 'STATE';
  return null;
}

/** "PIN 413102", "PIN codes starting 413", "Solapur district". */
export function areaLabel(area, t) {
  switch (areaKind(area)) {
    case 'PIN':
      return t('deliveryAreas.labelPin', { pin: area.pincode, defaultValue: 'PIN {{pin}}' });
    case 'PREFIX':
      return t('deliveryAreas.labelPrefix', { prefix: area.pincodePrefix, defaultValue: 'PIN codes starting {{prefix}}' });
    case 'DISTRICT':
      return t('deliveryAreas.labelDistrict', { district: area.district, defaultValue: '{{district}} district' });
    case 'STATE':
      return area.state;
    default:
      return '—';
  }
}

/** "Same day", "1 day", "3 days", "1–2 days". */
export function etaLabel(minDays, maxDays, t) {
  const min = Number(minDays);
  const max = Number(maxDays);
  if (minDays == null || maxDays == null || !Number.isFinite(min) || !Number.isFinite(max)) return '—';
  if (max === 0) return t('deliveryAreas.etaSameDay', 'Same day');
  if (min === max) {
    return max === 1
      ? t('deliveryAreas.etaOneDay', '1 day')
      : t('deliveryAreas.etaDays', { n: max, defaultValue: '{{n}} days' });
  }
  return t('deliveryAreas.etaRange', { min, max, defaultValue: '{{min}}–{{max}} days' });
}

/**
 * A blank form. Starts on the seller's own PIN code: the first area a Kendra
 * delivers to is the one it stands in, and a pre-filled field is one fewer for
 * someone typing on a phone in a shop doorway.
 */
export function emptyAreaForm(sellerPincode) {
  const pin = cleanDigits(sellerPincode, 6);
  return {
    id: null,
    kind: 'PIN',
    pincode: PIN_RE.test(pin) ? pin : '',
    pincodePrefix: '',
    district: '',
    state: '',
    etaMinDays: '1',
    etaMaxDays: '2',
    surcharge: '',
    codAvailable: true,
    pickupAvailable: false,
  };
}

/** A saved row, as form values, for editing its estimate and charge. */
export function formFromArea(area) {
  const surcharge = Number(area?.surcharge);
  return {
    id: area?.id ?? null,
    kind: areaKind(area) || 'PIN',
    pincode: str(area?.pincode),
    pincodePrefix: str(area?.pincodePrefix),
    district: str(area?.district),
    state: str(area?.state),
    etaMinDays: String(area?.etaMinDays ?? ''),
    etaMaxDays: String(area?.etaMaxDays ?? ''),
    surcharge: Number.isFinite(surcharge) && surcharge > 0 ? String(surcharge) : '',
    // Not editable on the screen yet, so they are carried: the route writes
    // `codAvailable !== false` and `pickupAvailable === true`, and a save that
    // left them out would silently reset both.
    codAvailable: area?.codAvailable !== false,
    pickupAvailable: area?.pickupAvailable === true,
  };
}

/**
 * The form after a save. Adding one area is usually followed by adding its
 * neighbour — the next village's PIN code, on the same run, at the same charge —
 * so a fresh add keeps the kind, the times and the charge and clears only the
 * area itself. An edit goes back to a blank form.
 */
export function nextFormAfterSave(form) {
  const blank = emptyAreaForm('');
  if (form?.id) return blank;
  return {
    ...blank,
    kind: AREA_KINDS.includes(form?.kind) ? form.kind : blank.kind,
    etaMinDays: str(form?.etaMinDays) || blank.etaMinDays,
    etaMaxDays: str(form?.etaMaxDays) || blank.etaMaxDays,
    surcharge: str(form?.surcharge),
  };
}

function dayError(value, t) {
  const s = str(value);
  if (!/^\d+$/.test(s) || Number(s) > ETA_MAX_DAYS) {
    return t('deliveryAreas.errDays', { max: ETA_MAX_DAYS, defaultValue: 'Enter days from 0 to {{max}}.' });
  }
  return null;
}

/** Field errors keyed by field name. An empty object means the form can be sent. */
export function validateAreaForm(form, t) {
  const errors = {};

  if (form.kind === 'PIN' && !PIN_RE.test(str(form.pincode))) {
    errors.pincode = t('deliveryAreas.errPin', 'Enter a 6-digit PIN code.');
  }
  if (form.kind === 'PREFIX' && !PREFIX_RE.test(str(form.pincodePrefix))) {
    errors.pincodePrefix = t('deliveryAreas.errPrefix', 'Enter the first 3 digits of a PIN code.');
  }
  if (form.kind === 'DISTRICT' && !str(form.district)) {
    errors.district = t('deliveryAreas.errDistrict', 'Choose a district.');
  }

  const minErr = dayError(form.etaMinDays, t);
  const maxErr = dayError(form.etaMaxDays, t);
  if (minErr) errors.etaMinDays = minErr;
  if (maxErr) errors.etaMaxDays = maxErr;
  if (!minErr && !maxErr && Number(str(form.etaMaxDays)) < Number(str(form.etaMinDays))) {
    errors.etaMaxDays = t('deliveryAreas.errEtaOrder', 'The slowest time cannot be less than the fastest.');
  }

  const amount = str(form.surcharge);
  if (amount && (!AMOUNT_RE.test(amount) || Number(amount) > SURCHARGE_MAX)) {
    errors.surcharge = t('deliveryAreas.errSurcharge', 'Enter an amount in rupees, or leave it empty.');
  }

  return errors;
}

/** The POST body for a form that passed validateAreaForm. */
export function buildAreaPayload(form) {
  const area =
    form.kind === 'PIN' ? { pincode: str(form.pincode) }
      : form.kind === 'PREFIX' ? { pincodePrefix: str(form.pincodePrefix) }
        : form.kind === 'DISTRICT' ? { district: str(form.district) }
          : { state: str(form.state) };
  return {
    ...area,
    etaMinDays: Number(str(form.etaMinDays)),
    etaMaxDays: Number(str(form.etaMaxDays)),
    surcharge: Number(str(form.surcharge) || 0),
    codAvailable: form.codAvailable !== false,
    pickupAvailable: form.pickupAvailable === true,
  };
}

const KIND_RANK = { PIN: 0, PREFIX: 1, DISTRICT: 2, STATE: 3 };
const areaValue = (a) => str(a?.pincode || a?.pincodePrefix || a?.district || a?.state).toLowerCase();

/** Most specific first, then by value — the order the server applies them in. */
export function sortAreas(areas) {
  return [...(areas || [])].sort((a, b) => {
    const rank = (KIND_RANK[areaKind(a)] ?? 9) - (KIND_RANK[areaKind(b)] ?? 9);
    return rank || areaValue(a).localeCompare(areaValue(b));
  });
}

/**
 * `areas` after the server returns `saved`. The route upserts on the area a row
 * covers, so saving an area that already exists returns the SAME row id and
 * must replace it rather than appear twice.
 */
export function upsertArea(areas, saved) {
  if (!saved?.id) return areas || [];
  const rest = (areas || []).filter((a) => a.id !== saved.id);
  return sortAreas([...rest, saved]);
}
