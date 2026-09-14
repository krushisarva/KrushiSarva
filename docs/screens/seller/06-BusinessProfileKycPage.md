# Business Profile & KYC

> **App:** seller-app · **Stack:** SellerNavigator (single stack) · **Route name:** `BusinessProfile` · **File:** `seller-app/src/screens/BusinessProfileScreen.js` · **Logic:** `seller-app/src/utils/businessProfile.js`

## Purpose
The seller onboarding / KYC form. Captures display name, business type, location, GST, bank account and KYC identifiers (Aadhaar, PAN), and shows the account's KYC status. Submitting it is the explicit consent that authorises a FARMER→SELLER role promotion. Used by existing sellers to update their details and by accounts that are not sellers yet as the app's first screen.

## Where it sits / how you reach it
- **Reached from:**
  - App start, when the account's role is not a seller role (`hasSellerRole` in `shared/utils/roles.js`: SELLER, VERIFIED_FARMER, ADMIN). Role only — a FARMER with a business type on file used to be sent to a dashboard where every seller endpoint 403s.
  - Seller Profile — completion card, location / business type / GST / bank / KYC status rows, and the "Business profile & KYC" row.
- **Navigates to:** after a successful save, `goBack()` when there is a screen behind, otherwise `replace('SellerDashboard')`. If the save succeeds but the account is still not a seller role, it stays and explains why.
- **Route params in:** none. Not deep-linkable (see `navigation/linking.js`).

## How it works
1. **Wait for the full profile.** `useProfileSync` fetches `GET /users/me` on focus when the account in AuthContext is incomplete or older than 30 s. Straight after an OTP login AuthContext holds only the login response (id, phone, name, role); the form is not mounted until the full profile arrives, with a skeleton meanwhile and an error state with Retry if it can't load.
2. **Start values** come from `initialFormFromUser`. Encrypted fields (account number, Aadhaar, PAN) start blank; the API returns them masked and the mask is shown as the placeholder with an "On file" badge. No business type is pre-selected for a new seller. A stored district or taluka the picker can't show (renamed district, a location set in the buyer app) starts empty instead of being resubmitted unseen; Dharashiv / Chhatrapati Sambhajinagar / Ahilyanagar map to the list's names.
3. **Editing.** `applyFieldChange` strips spaces and separators from pasted ID numbers and uppercases PAN / IFSC / GST. Changing district clears taluka; ticking "no GST" clears the number and unticking restores the stored one. A new account number reveals a "Re-enter account number" field.
4. **Validation** (`validateBusinessProfile`) reports every problem at once. Errors appear on blur for fields with something typed, and on Save; a flagged field re-checks as it is edited. Save scrolls to the first error (measured against the ScrollView; `scrollIntoView` on web).
5. **Save** sends `PUT /users/me` with `buildBusinessProfilePayload`. Holder name, bank name, IFSC and GST are sent only when they change what is stored (or nothing is stored yet), and Aadhaar / PAN / account number only when typed.
6. **After save:** fresh tokens (role upgrade) are persisted with `saveTokens` and kept out of the user object; the context user is updated; the form resets to the saved values.

## UI elements

| Element | Description / action |
|---|---|
| Intro card | Purpose + security line, completion meter (10 fields, same formula as the API), KYC status badge with explanation. A rejection shows the admin's reason. Accounts with nothing behind this screen also get "Signed in with the wrong number? Log out". |
| Notices | Minor account (Save disabled), saved-but-not-promoted, "fix the highlighted fields" summary |
| 01 Business identity | Display name (required, 2–80), business type chips (required, none pre-selected) |
| 02 Location | State (fixed Maharashtra), district picker, taluka picker (disabled until district), village / town (required) |
| 03 GST | "I don't have a GST number" checkbox; GST number (required when unticked, format + check character) |
| 04 Bank account | Holder name, bank name, account number (9–18 digits, masked placeholder when on file), re-enter account number, IFSC. An account typed or on file requires IFSC and holder name; bank details without an account number ask for it. |
| 05 KYC | Aadhaar (12 digits, cannot start with 0/1, Verhoeff check digit), PAN (format) |
| Save (action bar) | Validates, re-checks a stale offline flag, then saves. Back is blocked while a save is in flight. |

## Services, APIs & data
- `GET /users/me` — full profile, via `useProfileSync` (shared across screens, one request at a time).
- `PUT /users/me` — the business/KYC payload with `sellerConsent: true`. May return an upgraded role and `tokens`.
- A 400 from the validator middleware (`error.details[].path`) is mapped to inline field errors via `serverFieldErrorKeys` / `serverFieldMessage`.
- The API rate-limits requests carrying non-empty sensitive fields to 5 per hour per user (`backend/src/constants/pii.js`); the diffed payload is what keeps ordinary edits out of that budget.

## Languages / i18n
`sellerBizProfile.*` and `sellerProfile.*`, with native Hindi and Marathi for every string this screen uses. `seller-app/src/utils/__tests__/sellerProfileI18n.test.js` fails if a bare `t()` key on this screen is missing in en/hi/mr.

## Notes, edge cases & gaps
- **KYC documents and Kendra licences have no upload UI here.** The API has `POST /users/me/kyc-documents` and `/me/licence-documents`; admins review the stored images, but the seller app never sends any.
- **A rejected seller who fixes their details stays `REJECTED`.** `PUT /users/me` does not move `kycStatus` back to `PENDING`, so the admin queue's PENDING filter will not show the resubmission.
- `PUT /users/me` only promotes FARMER. LABOUR_PROVIDER and MACHINERY_OWNER accounts, and minors, get the "not switched to a seller account" notice.
- `PUT /users/me` is not behind `blockMinors` (unlike `/me/seller-profile`); the form disables Save for `isMinor` accounts, but the API itself would accept the data.
- `state` is hardcoded to Maharashtra, and the district list is Maharashtra-only.
