-- PAY-001 — one payment core every product area can raise an intent against.
--
-- WHY: PaymentIntent was AgriStore-shaped. `cartHash`, `quoteSnapshot` and
-- `orderId` all name shop concepts, so rent bookings, AI credit packs and any
-- later purpose had nowhere to record WHAT the money was for. Without a
-- discriminator the webhook cannot dispatch and the reconciler cannot tell a
-- rent payment from a shop payment — and its shop behaviour (no order found →
-- release stock reservations → auto-refund after 30 min) would be applied to
-- a rent booking that is merely slow. `purpose` is the column that makes that
-- impossible.
--
-- PURELY ADDITIVE. No drop, no rename, no type change on an existing column,
-- no backfill:
--   * `purpose` is NOT NULL but DEFAULT 'SHOP_ORDER', which is what every
--     existing row genuinely is — they are all AgriStore checkouts, that being
--     the only flow that has ever written this table. On Postgres 11+ an
--     ADD COLUMN with a constant default is a catalog change, not a table
--     rewrite, so this does not lock out in-flight checkouts.
--   * `refType` / `refId` / `metadata` are nullable with no default. A
--     SHOP_ORDER intent leaves them NULL and keeps using quoteSnapshot/cartHash.
--
-- The two new indexes both include NULL rows (btree indexes NULLs), which on
-- `payment_intents` — one row per checkout attempt — is nothing. A partial
-- index would be smaller but Prisma cannot express one, so `db push` would
-- drop and recreate it on every deploy.
--
-- See prisma/manual/payment_intent_purpose_additive.sql for the prod-apply
-- variant. The deploy runs `prisma db push`, which cannot be used against
-- production: it would try to drop the FastAPI-owned tables it does not know
-- about (ai_scan_diagnoses, ai_scan_feedback), abort on data loss, and then
-- NONE of this would land.

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('SHOP_ORDER', 'RENT_BOOKING', 'AI_CREDITS', 'ANIMAL_TOKEN');

-- AlterTable
ALTER TABLE "payment_intents"
  ADD COLUMN "purpose" "PaymentPurpose" NOT NULL DEFAULT 'SHOP_ORDER',
  ADD COLUMN "refType" TEXT,
  ADD COLUMN "refId" TEXT,
  ADD COLUMN "metadata" JSONB;

-- CreateIndex
CREATE INDEX "payment_intents_purpose_status_createdAt_idx" ON "payment_intents"("purpose", "status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_intents_refType_refId_idx" ON "payment_intents"("refType", "refId");
