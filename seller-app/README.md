# KrushiSarva Seller

Standalone Expo app for **sellers**: list products, manage orders, complete KYC, and
answer crop reports farmers forward from the buyer app.

Split out of `frontend/` — the buyer app no longer contains any seller screens.
Both apps share one backend, one account system (the same OTP login), and the
`../shared` package.

| | |
| --- | --- |
| Bundle id | `com.cropsetu.seller` |
| Scheme | `krushisarva-seller://` |
| Buyer app | `../frontend` (`com.cropsetu.app`) |
| Shared code | `../shared` (see its README) |

## Setup

```bash
npm install
cp .env.example .env      # point EXPO_PUBLIC_API_BASE_URL at your backend
npm start
```

The buyer app's Metro usually holds port 8081, so run this one on another port:

```bash
npx expo start --port 8082
```

## Screens

| Route | File | What it does |
| --- | --- | --- |
| `SellerDashboard` | `src/screens/DashboardScreen.js` | stats, recent orders, unread report count |
| `SellerMyProducts` | `src/screens/MyProductsScreen.js` | list / edit / delete / toggle stock |
| `AddProduct` | `src/screens/AddProductScreen.js` | create + edit listing, image upload |
| `SellerOrders` | `src/screens/OrdersScreen.js` | orders, status transitions |
| `SellerProfile` | `src/screens/SellerProfileScreen.js` | account + shop details |
| `BusinessProfile` | `src/screens/BusinessProfileScreen.js` | GST / PAN / Aadhaar / bank KYC |
| `ReceivedReports` | `src/screens/ReceivedReportsScreen.js` | crop reports farmers shared |
| `ReceivedReportDetail` | `src/screens/ReceivedReportDetailScreen.js` | one report + reply with products |

## Entry routing

`src/navigation/SellerNavigator.js` picks the landing screen from the account:

- **Not a seller yet** → `BusinessProfile`. Saving it makes the backend flip the
  role `FARMER → SELLER` and return fresh tokens; the navigator then remounts at
  the dashboard.
- **Already a seller** → `SellerDashboard`.

`isSellerAccount()` lives in `../shared/utils/roles.js` so the buyer app's profile
badge and this gate can never disagree.

## API

Every endpoint is on the shared backend; no seller-only service exists.

```
GET    /agristore/seller/stats
GET    /agristore/seller/products            POST /agristore/seller/products
PUT    /agristore/seller/products/:id        DELETE /agristore/seller/products/:id
GET    /agristore/seller/orders              PUT  /agristore/seller/orders/:id/status
GET    /crop-reports/seller/inbox            GET  /crop-reports/seller/inbox/:shareId
POST   /crop-reports/seller/inbox/:shareId/reply
GET    /agristore/categories
POST   /upload/image
PUT    /users/me
```

## Cloud builds (EAS Build) and `../shared`

EAS Build uploads the whole git repository, not just this folder, so `../shared`
is included and cloud builds work without any extra set-up. Run builds from this
folder:

```
npx eas build --platform android --profile preview --non-interactive
```

The Expo account is on the free plan, and a failed build still uses up one of the
month's builds. Run `npx expo export --platform android --output-dir <a temp folder>`
first as a free check that the app bundles.
