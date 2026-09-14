# Seller Profile

> **App:** seller-app · **Stack:** SellerNavigator (single stack) · **Route name:** `SellerProfile` · **File:** `seller-app/src/screens/SellerProfileScreen.js`

## Purpose
The seller's account and settings page: identity, profile completion, account details, business details (type, GST, bank, KYC status), and links to the business profile form, help and legal pages. The display name can be edited inline.

## Where it sits / how you reach it
- **Reached from:** Seller Dashboard — avatar and the "Profile" quick action.
- **Navigates to:** `BusinessProfile` from the completion card and the location, business type, GST, bank, KYC status and "Business profile & KYC" rows. Terms / Privacy open in the browser. Log out asks first.
- **Route params in:** none.

## How it works
Reads `user` from AuthContext. `useProfileSync` fetches `GET /users/me` on focus when that copy is incomplete (right after an OTP login it holds only id, phone, name, role) or older than 30 s. Until the full profile is there, business rows and the completion figure show skeletons rather than "Not added"; if the fetch fails, a notice with Retry appears above the completion card.

Completion uses `completionFromUser` from `seller-app/src/utils/businessProfile.js` — the same ten fields the business profile form and the API count. KYC status uses `kycState`:

| API state | Row shows |
|---|---|
| `VERIFIED` (or `kycVerifiedAt` set) | Verified |
| `REJECTED` | "Rejected: {reason}" (or "tap to update your details"), red badge |
| `SUBMITTED`, or `PENDING` with Aadhaar/PAN on file | Pending verification |
| `PENDING` with nothing on file | Not submitted — tap to add Aadhaar or PAN |

`PENDING` is the column default for every account, so it is not read as "submitted" on its own.

The display name editor focuses its input, requires 2–80 characters (the API's limits), re-checks a stale offline flag before saving, and saves with `PUT /users/me { name }`.

## UI elements

| Element | Description / action |
|---|---|
| Identity header | Avatar, name, phone, business type badge, edit button |
| Completion card | % and bar (skeleton while loading) → `BusinessProfile` |
| Account | Phone, display name (→ edit), location (→ `BusinessProfile`) |
| Business | Business type, GST (opt-out shows "Exempt"; a number shows "Added" — GST numbers are not verified by anyone), bank (masked last 4 + bank name, "Added"), KYC status |
| Seller | Seller since (`createdAt`), account status |
| More | Business profile & KYC, help centre, terms, privacy |
| Log out | Confirm, then `logout()` |

## Services, APIs & data
- `GET /users/me` via `useProfileSync`.
- `PUT /users/me` with `{ name }`.

## Notes, edge cases & gaps
- "Seller since" is the account creation date, not the date the account became a seller.
- The help message still lists `support@cropsetu.app` and `+91 8000 123 456`, and Terms / Privacy point at `cropsetu.app`.
