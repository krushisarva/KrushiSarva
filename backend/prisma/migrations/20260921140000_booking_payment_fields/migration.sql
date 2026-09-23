-- PAY-002 — rent bookings can be paid for.
--
-- WHY: a Booking carried `totalAmount` and nothing else about money. Bookings
-- were created PENDING with no payment path at all, so the platform quoted a
-- price it never collected. These four columns are what lets a booking be
-- raised FROM a captured payment instead of alongside one.
--
-- PURELY ADDITIVE. No drop, no rename, no type change, no backfill:
--   * `advanceAmount` is nullable with no default. NULL is the truthful value
--     for every booking that existed before this — none of them were ever
--     quoted an advance — and for every booking still created through the
--     legacy unpaid POST /rent/bookings, which old installed app builds use
--     and which this change deliberately leaves working.
--   * `paidAmount` is NOT NULL DEFAULT 0. Nothing was collected on any
--     existing row, so the default IS the fact; no backfill is needed. On
--     Postgres 11+ an ADD COLUMN with a constant default is a catalog-only
--     change, so this does not rewrite or lock the table.
--   * `paymentStatus` is NOT NULL DEFAULT 'UNPAID' for the same reason.
--   * `paymentIntentId` is nullable and UNIQUE. The unique index is the whole
--     safety property: it makes "one captured payment produces at most one
--     booking" a database guarantee rather than a code convention, so a
--     retried confirm, a webhook and the reconciler cannot each create one.
--     Postgres btree treats NULLs as distinct, so the millions of unpaid
--     bookings that will keep being created do not collide.
--
-- See prisma/manual/booking_payment_fields_additive.sql for the prod-apply
-- variant. The deploy runs `prisma db push`, which cannot be used against
-- production: it would try to drop the FastAPI-owned tables it does not know
-- about (ai_scan_diagnoses, ai_scan_feedback), abort on data loss, and then
-- NONE of this would land.

-- AlterTable
ALTER TABLE "bookings"
  ADD COLUMN "advanceAmount"   DECIMAL(12, 2),
  ADD COLUMN "paidAmount"      DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "paymentIntentId" TEXT,
  ADD COLUMN "paymentStatus"   TEXT NOT NULL DEFAULT 'UNPAID';

-- CreateIndex
CREATE UNIQUE INDEX "bookings_paymentIntentId_key" ON "bookings"("paymentIntentId");
