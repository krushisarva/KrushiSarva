-- order_items.batchQuantity — additive schema, safe to apply MANUALLY in prod.
--
-- WHY MANUAL: the Railway deploy runs `prisma db push`, which makes the DB match
-- schema.prisma EXACTLY and therefore tries to DROP the FastAPI-owned tables it
-- doesn't know about (ai_scan_diagnoses, mandi_prices, …). Once those hold data,
-- db push aborts ("data loss") and NONE of the schema applies — so this new
-- column would silently never land. This script applies only the additive
-- change. NEVER add --accept-data-loss to the deploy.
--
-- WHAT IT FIXES: the lot ledger credited an order's LINE quantity back on cancel
-- while the allocation had only ever drawn what the lot physically held. A
-- Kendra whose recorded lot quantities under-cover the stock they are offering
-- ended up with units on a lot that had never been there, which a recall then
-- over-reported and FEFO went on allocating. No oversell and no money impact:
-- seller_listings.stockQty is the oversell guarantee and is restored in full by
-- a separate path.
--
-- APPLY (any one):
--   cd backend && DATABASE_URL=<prod> npx prisma db execute --file prisma/manual/order_item_batch_quantity_additive.sql --schema prisma/schema.prisma
--   psql "$DATABASE_URL" -f backend/prisma/manual/order_item_batch_quantity_additive.sql
--   Railway -> Postgres service -> Data/Query tab -> paste + run
--
-- Nullable, no default, no backfill, no rewrite of existing rows: an ADD COLUMN
-- of a nullable column takes only a brief catalog lock on Postgres 11+.
-- Idempotent: safe to re-run. Apply BEFORE deploying the code that writes it.

BEGIN;

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "batchQuantity" INTEGER;

COMMIT;
