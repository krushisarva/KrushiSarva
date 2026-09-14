/**
 * Business profile / KYC form logic — no React, no React Native.
 *
 * BusinessProfileScreen and SellerProfileScreen both read this, so the two
 * screens can no longer disagree about what "complete" or "verified" means
 * (they did: one counted eight fields, the other ten, and the KYC row compared
 * `kycStatus` against a lowercase 'verified' the API never sends).
 *
 * Every function takes `t` (or nothing) and returns plain data, which is what
 * lets frontend/jest.config.js test it without a renderer.
 */
import { BUSINESS_TYPES, DISTRICT_LIST, getTalukas } from '@krushisarva/shared/constants/locations';
import {
  isAadhaarChecksumValid, isGstChecksumValid, isValidAadhaar, isValidBankAccount,
  isValidGst, isValidIfsc, isValidPan,
} from '@krushisarva/shared/utils/validators';

// Server limits (backend/src/routes/user.routes.js, PUT /me). Typing past them
// used to earn a generic "Invalid request" instead of a field error.
export const NAME_MIN = 2;
export const NAME_MAX = 80;
export const TEXT_MAX = 100;

/** Longest value each ID field keeps after cleaning. */
export const ID_LENGTH = {
  aadharNumber: 12,
  bankAccountNumber: 18,
  bankAccountConfirm: 18,
  panNumber: 10,
  bankIfsc: 11,
  gstNumber: 15,
};

/**
 * `maxLength` for the ID inputs. Longer than ID_LENGTH on purpose: Android
 * truncates a paste to maxLength BEFORE onChangeText sees it, so "1234 5678 9012"
 * pasted into a 12-character field arrived as "1234 5678 90". The slack lets the
 * spaces through; cleaning then strips them.
 */
export const ID_INPUT_MAX = {
  aadharNumber: 20,
  bankAccountNumber: 26,
  bankAccountConfirm: 26,
  panNumber: 14,
  bankIfsc: 15,
  gstNumber: 19,
};

/** Top-to-bottom order of the form, used to scroll to the first error. */
export const FIELD_ORDER = [
  'name', 'businessType', 'district', 'taluka', 'village', 'gstNumber',
  'bankHolderName', 'bankName', 'bankAccountNumber', 'bankAccountConfirm', 'bankIfsc',
  'aadharNumber', 'panNumber',
];

const FORM_KEYS = [...FIELD_ORDER, 'gstOptOut'];

const passthroughT = (_key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue);

const clean = (v) => String(v ?? '').trim();

export const digitsOnly = (value, max) => String(value ?? '').replace(/\D/g, '').slice(0, max);
export const alphanumericUpper = (value, max) =>
  String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, max);

// ── Account state ────────────────────────────────────────────────────────────

/**
 * True once the account object came from GET or PUT /users/me.
 *
 * The login response carries only id/phone/name/role, and that thin object is
 * what sits in AuthContext right after an OTP login. Built into a form, it looked
 * like a seller with no district, no GST and no bank details, and saving it
 * overwrote the stored values with blanks.
 */
export function isProfileHydrated(user) {
  return !!user && user.sellerProfile !== undefined;
}

/** Masked values the API returns for the encrypted fields, or null. */
export function onFileFromUser(user) {
  const sp = user?.sellerProfile;
  return {
    aadhaar: sp?.aadharNumber || null,
    pan: sp?.panNumber || null,
    bankAccount: sp?.bankAccountNumber || null,
  };
}

/**
 * The seller-facing KYC state.
 *
 *   rejected   — admin rejected it; `reason` is theirs, if they gave one
 *   verified   — admin approved it
 *   pending    — licence documents submitted, or Aadhaar/PAN on file and
 *                waiting for an admin
 *   notStarted — nothing to review yet. `PENDING` is the database default for
 *                every account, so it cannot be read as "submitted" on its own.
 */
export function kycState(user) {
  const status = clean(user?.kycStatus).toUpperCase();
  const sp = user?.sellerProfile;
  if (status === 'REJECTED') return { key: 'rejected', reason: clean(sp?.kycRejectedReason) || null };
  if (status === 'VERIFIED' || sp?.kycVerifiedAt) return { key: 'verified', reason: null };
  if (status === 'SUBMITTED' || sp?.aadharNumber || sp?.panNumber) return { key: 'pending', reason: null };
  return { key: 'notStarted', reason: null };
}

// ── Completion ───────────────────────────────────────────────────────────────

const percentOf = (checks) => Math.round((checks.filter(Boolean).length / checks.length) * 100);

/** Mirrors calcProfileCompletion in backend/src/routes/user.routes.js. */
export function completionFromUser(user) {
  const sp = user?.sellerProfile;
  return percentOf([
    user?.name, user?.businessType, user?.district, user?.taluka, user?.village,
    user?.gstNumber || user?.gstOptOut,
    sp?.bankAccountNumber, sp?.bankIfsc, sp?.bankHolderName, sp?.bankName,
  ]);
}

/** The same ten checks, read from the form as it is being filled in. */
export function completionFromForm(form, onFile = {}) {
  return percentOf([
    clean(form.name), form.businessType, form.district, form.taluka, clean(form.village),
    form.gstOptOut || clean(form.gstNumber),
    clean(form.bankAccountNumber) || onFile.bankAccount,
    clean(form.bankIfsc), clean(form.bankHolderName), clean(form.bankName),
  ]);
}

// ── Form state ───────────────────────────────────────────────────────────────

// Districts renamed by the state. The buyer app's all-India list already uses
// some of the new names; the seller list still has the old ones, and a stored
// name the picker cannot show was rendered as "Select your district" while
// still being submitted.
const DISTRICT_ALIASES = {
  ahilyanagar: 'Ahmednagar',
  'ahilya nagar': 'Ahmednagar',
  'chhatrapati sambhajinagar': 'Aurangabad',
  dharashiv: 'Osmanabad',
};

/** The stored district as it appears in DISTRICT_LIST, or '' if it isn't there. */
export function canonicalDistrict(name) {
  const raw = clean(name);
  if (!raw) return '';
  const wanted = (DISTRICT_ALIASES[raw.toLowerCase()] || raw).toLowerCase();
  return DISTRICT_LIST.find((d) => d.toLowerCase() === wanted) || '';
}

/** The stored taluka as it appears under `district`, or ''. */
export function canonicalTaluka(district, taluka) {
  const raw = clean(taluka).toLowerCase();
  if (!raw || !district) return '';
  return getTalukas(district).find((x) => x.toLowerCase() === raw) || '';
}

const isKnownBusinessType = (key) => BUSINESS_TYPES.some((b) => b.key === key);

/**
 * The form's starting values. Encrypted fields always start blank — the API
 * only returns them masked, and blank means "keep what is on file".
 *
 * A business type is no longer pre-selected for a new seller. "Individual
 * farmer" was the default, so a Krushi Seva Kendra that did not notice saved
 * itself as a farmer and never appeared to farmers looking for a Kendra.
 */
export function initialFormFromUser(user) {
  const sp = user?.sellerProfile || {};
  const district = canonicalDistrict(user?.district);
  return {
    name: clean(user?.name),
    businessType: isKnownBusinessType(user?.businessType) ? user.businessType : '',
    district,
    taluka: canonicalTaluka(district, user?.taluka),
    village: clean(user?.village),
    gstOptOut: !!user?.gstOptOut || !user?.gstNumber,
    gstNumber: clean(user?.gstNumber).toUpperCase(),
    bankHolderName: clean(sp.bankHolderName),
    bankName: clean(sp.bankName),
    bankIfsc: clean(sp.bankIfsc).toUpperCase(),
    bankAccountNumber: '',
    bankAccountConfirm: '',
    aadharNumber: '',
    panNumber: '',
  };
}

/**
 * Apply one edit. ID fields are cleaned here, so a pasted "1234 5678 9012" or a
 * lowercase IFSC is stored in the shape the validators and the API expect.
 */
export function applyFieldChange(prev, key, raw, initial) {
  let value = raw;
  if (key === 'aadharNumber' || key === 'bankAccountNumber' || key === 'bankAccountConfirm') {
    value = digitsOnly(raw, ID_LENGTH[key]);
  } else if (key === 'panNumber' || key === 'bankIfsc' || key === 'gstNumber') {
    value = alphanumericUpper(raw, ID_LENGTH[key]);
  }

  const next = { ...prev, [key]: value };
  if (key === 'district' && value !== prev.district) next.taluka = '';
  // Ticking "no GST" hides the number, so it must not be submitted behind the
  // tick. Unticking brings back the one on file rather than an empty box.
  if (key === 'gstOptOut') next.gstNumber = value ? '' : (prev.gstNumber || initial?.gstNumber || '');
  if (key === 'bankAccountNumber' && !value) next.bankAccountConfirm = '';
  return next;
}

/** True when the form differs from `initial` in anything but whitespace. */
export function hasUnsavedChanges(form, initial) {
  if (!form || !initial) return false;
  return FORM_KEYS.some((k) => {
    const a = form[k];
    const b = initial[k];
    return typeof a === 'string' || typeof b === 'string' ? clean(a) !== clean(b) : a !== b;
  });
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Every problem at once, keyed by field.
 *
 * `onFile.bankAccount` matters: a seller whose account number is already stored
 * still needs an IFSC and holder name, and previously could clear either and
 * save, leaving an account nobody can pay into.
 */
export function validateBusinessProfile(form, { onFile = {}, t = passthroughT } = {}) {
  const e = {};

  if (clean(form.name).length < NAME_MIN) {
    e.name = t('sellerBizProfile.nameRequired', 'Enter your name (at least 2 letters)');
  }
  if (!isKnownBusinessType(form.businessType)) {
    e.businessType = t('sellerBizProfile.selectBizTypeMsg', 'Choose your business type');
  }

  if (!DISTRICT_LIST.includes(form.district)) {
    e.district = t('sellerBizProfile.selectDistrictMsg', 'Please select your district');
  }
  if (!getTalukas(form.district).includes(form.taluka)) {
    e.taluka = t('sellerBizProfile.selectTalukaMsg', 'Please select your taluka');
  }
  if (clean(form.village).length < 2) {
    e.village = t('sellerBizProfile.enterVillageMsg', 'Please enter your village/town name');
  }

  if (!form.gstOptOut) {
    const gst = clean(form.gstNumber);
    if (!gst) {
      e.gstNumber = t('sellerBizProfile.gstRequired', "Enter your GST number, or tick \"I don't have a GST number\"");
    } else if (!isValidGst(gst)) {
      e.gstNumber = t('sellerBizProfile.invalidGstMsg', 'Enter a valid 15-character GST number');
    } else if (!isGstChecksumValid(gst)) {
      e.gstNumber = t('sellerBizProfile.gstChecksumMsg', 'This GST number has a typo. Check it against your GST certificate.');
    }
  }

  const account = clean(form.bankAccountNumber);
  const confirm = clean(form.bankAccountConfirm);
  const ifsc = clean(form.bankIfsc);
  const holder = clean(form.bankHolderName);
  const hasAccount = !!account || !!onFile.bankAccount;

  if (account && !isValidBankAccount(account)) {
    e.bankAccountNumber = t('sellerBizProfile.invalidAccountMsg', 'Account number must be 9 to 18 digits');
  } else if (account && confirm !== account) {
    e.bankAccountConfirm = t('sellerBizProfile.accountMismatch', 'Account numbers do not match');
  } else if (!hasAccount && (ifsc || holder || clean(form.bankName))) {
    e.bankAccountNumber = t('sellerBizProfile.accountRequired', 'Enter your account number to complete your bank details');
  }

  if (ifsc && !isValidIfsc(ifsc)) {
    e.bankIfsc = t('sellerBizProfile.invalidIfscMsg', 'IFSC must be 11 characters (e.g. SBIN0012345)');
  } else if (hasAccount && !ifsc) {
    e.bankIfsc = t('sellerBizProfile.ifscRequiredWithAcct', 'Enter the IFSC code for this account');
  }
  if (hasAccount && holder.length < 2) {
    e.bankHolderName = t('sellerBizProfile.holderRequired', 'Enter the account holder name as printed in your passbook');
  }

  const aadhaar = clean(form.aadharNumber);
  if (aadhaar && !isValidAadhaar(aadhaar)) {
    e.aadharNumber = t('sellerBizProfile.invalidAadhaar', 'Aadhaar must be exactly 12 digits');
  } else if (aadhaar && !isAadhaarChecksumValid(aadhaar)) {
    e.aadharNumber = t('sellerBizProfile.aadhaarChecksumMsg', 'This Aadhaar number is not valid. Check the 12 digits on your card.');
  }

  const pan = clean(form.panNumber);
  if (pan && !isValidPan(pan)) {
    e.panNumber = t('sellerBizProfile.invalidPan', 'Invalid PAN format (e.g. ABCDE1234F)');
  }

  return e;
}

/** First field, top to bottom, that has an error — or undefined. */
export function firstErrorKey(errors) {
  return FIELD_ORDER.find((k) => errors?.[k]);
}

// ── Payload ──────────────────────────────────────────────────────────────────

/**
 * The PUT /users/me body.
 *
 * Holder name, bank name, IFSC and GST are sent only when they change what is
 * stored (or nothing is stored yet). The API counts every request carrying one
 * of them, non-empty, against a budget of five per hour; the old form echoed all
 * four back on every save, so a seller correcting their village a few times was
 * told "Too many updates to sensitive details". Empty values never count, which
 * is also why a first save still sends them: it creates the seller profile row.
 *
 * Aadhaar, PAN and the account number are sent only when typed. An empty string
 * there would be encrypted and replace what is on file.
 */
export function buildBusinessProfilePayload(form, user) {
  const sp = user?.sellerProfile || {};
  const payload = {
    // Submitting this form is the explicit opt-in that authorises a
    // FARMER → SELLER promotion; the backend records it as consent.
    sellerConsent: true,
    businessType: form.businessType,
    district: form.district,
    taluka: form.taluka,
    village: clean(form.village),
    state: 'Maharashtra',
    gstOptOut: !!form.gstOptOut,
  };

  const name = clean(form.name);
  if (name !== clean(user?.name)) payload.name = name;

  const sendIfChanged = (key, next, stored) => {
    const prev = clean(stored);
    if (!prev || next !== prev) payload[key] = next;
  };
  sendIfChanged('gstNumber', form.gstOptOut ? '' : clean(form.gstNumber).toUpperCase(), clean(user?.gstNumber).toUpperCase());
  sendIfChanged('bankHolderName', clean(form.bankHolderName), sp.bankHolderName);
  sendIfChanged('bankName', clean(form.bankName), sp.bankName);
  sendIfChanged('bankIfsc', clean(form.bankIfsc).toUpperCase(), clean(sp.bankIfsc).toUpperCase());

  const account = clean(form.bankAccountNumber);
  const aadhaar = clean(form.aadharNumber);
  const pan = clean(form.panNumber).toUpperCase();
  if (account) payload.bankAccountNumber = account;
  if (aadhaar) payload.aadharNumber = aadhaar;
  if (pan) payload.panNumber = pan;

  return payload;
}

// ── Server errors ────────────────────────────────────────────────────────────

const SERVER_FIELDS = new Set([
  'name', 'businessType', 'district', 'taluka', 'village', 'gstNumber',
  'bankHolderName', 'bankName', 'bankAccountNumber', 'bankIfsc', 'aadharNumber', 'panNumber',
]);

/**
 * Form fields named in a 400 from the validator middleware. The shared error
 * helper turns every 400 into "Invalid request. Please check your details",
 * which on a form this long does not say which of thirteen fields to check.
 */
export function serverFieldErrorKeys(error) {
  if (error?.response?.status !== 400) return [];
  const details = error.response.data?.error?.details;
  if (!Array.isArray(details)) return [];
  return [...new Set(details.map((d) => d?.path ?? d?.param).filter((k) => SERVER_FIELDS.has(k)))];
}

/** A translated message for a field the server rejected. */
export function serverFieldMessage(key, t = passthroughT) {
  switch (key) {
    case 'name': return t('sellerBizProfile.nameRequired', 'Enter your name (at least 2 letters)');
    case 'businessType': return t('sellerBizProfile.selectBizTypeMsg', 'Choose your business type');
    case 'district': return t('sellerBizProfile.selectDistrictMsg', 'Please select your district');
    case 'taluka': return t('sellerBizProfile.selectTalukaMsg', 'Please select your taluka');
    case 'village': return t('sellerBizProfile.enterVillageMsg', 'Please enter your village/town name');
    case 'gstNumber': return t('sellerBizProfile.invalidGstMsg', 'Enter a valid 15-character GST number');
    case 'bankAccountNumber': return t('sellerBizProfile.invalidAccountMsg', 'Account number must be 9 to 18 digits');
    case 'bankIfsc': return t('sellerBizProfile.invalidIfscMsg', 'IFSC must be 11 characters (e.g. SBIN0012345)');
    case 'aadharNumber': return t('sellerBizProfile.invalidAadhaar', 'Aadhaar must be exactly 12 digits');
    case 'panNumber': return t('sellerBizProfile.invalidPan', 'Invalid PAN format (e.g. ABCDE1234F)');
    default: return t('sellerBizProfile.checkField', 'Please check this field');
  }
}
