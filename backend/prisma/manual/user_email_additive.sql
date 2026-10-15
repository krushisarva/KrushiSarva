-- User contact email — additive schema, safe to apply MANUALLY in prod.
--
-- WHY MANUAL: the old deploy ran `prisma db push`, which makes the DB match
-- schema.prisma EXACTLY and therefore tries to DROP the FastAPI-owned tables it
-- doesn't know about (ai_scan_diagnoses, mandi_prices, …). Once those hold data,
-- db push aborts ("data loss") and NONE of the schema applies — so the new
-- `users.email` column would silently never land. This script applies only the
-- additive email change. NEVER add --accept-data-loss to the deploy.
--
-- APPLY (any one):
--   cd backend && DATABASE_URL=<prod> npx prisma db execute --file prisma/manual/user_email_additive.sql --schema prisma/schema.prisma
--   psql "$DATABASE_URL" -f backend/prisma/manual/user_email_additive.sql
--   On the VPS, over SSH (Postgres has no public port; ks_app owns the tables):
--     cd /opt/krushisarva
--     docker compose exec -T postgres sh -c 'psql -U ks_app -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--       < app/backend/prisma/manual/user_email_additive.sql
--   (The VPS database, built by `prisma db push` on 2026-10-14, already has this.)
--
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" TEXT;

-- Unique index (NULLs allowed many times). Guarded so re-runs don't error.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

COMMIT;
