-- Krushi Seva Kendra licence — additive schema, safe to apply MANUALLY in prod.
--
-- WHY MANUAL: the old deploy ran `prisma db push`, which makes the DB match
-- schema.prisma EXACTLY and therefore tries to DROP the FastAPI-owned tables it
-- doesn't know about (ai_scan_diagnoses, mandi_prices, …). Once those hold data,
-- db push aborts ("data loss") and NONE of the schema applies — so these new
-- seller_profiles.licence* columns would silently never land. This script applies
-- only the additive licence change. NEVER add --accept-data-loss to the deploy.
--
-- APPLY (any one):
--   cd backend && DATABASE_URL=<prod> npx prisma db execute --file prisma/manual/seller_licence_additive.sql --schema prisma/schema.prisma
--   psql "$DATABASE_URL" -f backend/prisma/manual/seller_licence_additive.sql
--   On the VPS, over SSH (Postgres has no public port; ks_app owns the tables):
--     cd /opt/krushisarva
--     docker compose exec -T postgres sh -c 'psql -U ks_app -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--       < app/backend/prisma/manual/seller_licence_additive.sql
--   (The VPS database, built by `prisma db push` on 2026-10-14, already has this.)
--
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "licenceNumber" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "licenceType" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "licenceIssuingState" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "licenceExpiry" TIMESTAMP(3);
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "licenceDocUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "licenceVerifiedAt" TIMESTAMP(3);

COMMIT;
