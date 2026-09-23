-- bookings.advanceAmount / paidAmount / paymentIntentId / paymentStatus —
-- additive schema, safe to apply MANUALLY in production. PAY-002.
--
-- WHY MANUAL: the Railway deploy runs `prisma db push`, which makes the DB match
-- schema.prisma EXACTLY and therefore tries to DROP the FastAPI-owned tables it
-- doesn't know about (ai_scan_diagnoses, ai_scan_feedback). Once those hold
-- data, db push aborts ("data loss") and NONE of the schema applies — so these
-- columns would silently never land. This script applies only the additive
-- change. NEVER add --accept-data-loss to the deploy.
--
-- WHAT IT ENABLES: a Booking carried `totalAmount` and nothing else about money.
-- Bookings were created PENDING with no payment path at all, so the platform
-- quoted a price it never collected. These four columns are what lets a booking
-- be raised FROM a captured payment instead of alongside one — and
-- `paymentIntentId`'s UNIQUE index is what makes "one captured payment produces
-- at most one booking" a database guarantee rather than a code convention.
--
-- SAFETY PROPERTIES
--   * Additive only. No DROP, no RENAME, no type change to an existing column.
--   * No backfill. `advanceAmount` NULL is the truth for every existing row
--     (none was ever quoted an advance), and `paidAmount` 0 / `paymentStatus`
--     'UNPAID' are the truth for the same reason. On Postgres 11+ ADD COLUMN
--     with a constant default is a catalog-only change: no table rewrite, no
--     long lock.
--   * The legacy unpaid POST /rent/bookings keeps working unchanged and keeps
--     writing rows that leave all four at their defaults. Old installed app
--     builds depend on it; this is deliberate, not an oversight.
--   * Idempotent. Safe to re-run; re-running changes nothing.
--   * Self-verifying. The final block re-reads the catalog and ABORTS THE WHOLE
--     TRANSACTION if the end state is not exactly what schema.prisma expects,
--     so a partial apply cannot be mistaken for a successful one.
--   * lock_timeout is 3s. `bookings` is on the rent write path; if a long
--     transaction holds a conflicting lock this fails fast and is retried,
--     rather than queueing and blocking every booking behind it.
--
-- ORDER OF OPERATIONS — THIS MATTERS:
--   1. Apply THIS script.
--   2. THEN deploy the code.
--   Reversing them breaks production: Prisma selects every scalar field it
--   knows about, so code that knows `paymentStatus` issues
--   SELECT ... "paymentStatus" ... against a table without it, and every
--   booking read fails with 42703 (undefined_column) — including the existing
--   unpaid booking flow, which today works fine. The other order is harmless:
--   old code simply never mentions the new columns.
--
-- APPLY (any one):
--   cd backend && DATABASE_URL=<prod> npx prisma db execute --file prisma/manual/booking_payment_fields_additive.sql --schema prisma/schema.prisma
--   psql "$DATABASE_URL" -f backend/prisma/manual/booking_payment_fields_additive.sql
--   Railway -> Postgres service -> Data/Query tab -> paste + run
--
-- ON A VERY LARGE bookings TABLE: CREATE UNIQUE INDEX takes a SHARE lock
-- (blocking writes) for its duration. If that is ever material, build it
-- CONCURRENTLY first — outside any transaction, it cannot run inside one — and
-- this script will then find it present and skip it:
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "bookings_paymentIntentId_key" ON "bookings"("paymentIntentId");

BEGIN;

SET LOCAL lock_timeout = '3s';

-- A clear refusal beats "relation bookings does not exist" three screens into a
-- deploy.
DO $do$
BEGIN
  IF to_regclass('public.bookings') IS NULL THEN
    RAISE EXCEPTION
      'table bookings does not exist in this database. This script only extends an existing table — apply the base schema first.';
  END IF;
END
$do$;

-- A column that already exists with the WRONG type would be silently skipped by
-- ADD COLUMN IF NOT EXISTS, leaving the database and Prisma disagreeing — and
-- the failure would surface at runtime, on the payment path. Check instead.
-- Money columns are checked hardest: a booking's advance landing in a float
-- column is the one shape of drift that loses paise without ever erroring.
DO $do$
DECLARE
  r      record;
  actual text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('advanceAmount',   'numeric(12,2)'),
      ('paidAmount',      'numeric(12,2)'),
      ('paymentIntentId', 'text'),
      ('paymentStatus',   'text')
    ) AS v(col, expected)
  LOOP
    SELECT format_type(a.atttypid, a.atttypmod) INTO actual
    FROM pg_attribute a
    WHERE a.attrelid = 'public.bookings'::regclass
      AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped;

    IF actual IS NOT NULL AND actual <> r.expected THEN
      RAISE EXCEPTION
        'bookings.% already exists with type % — expected %. Resolve by hand; this script will not convert a column on a live bookings table.',
        r.col, actual, r.expected;
    END IF;
  END LOOP;
END
$do$;

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "advanceAmount"   DECIMAL(12, 2),
  ADD COLUMN IF NOT EXISTS "paidAmount"      DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paymentIntentId" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentStatus"   TEXT NOT NULL DEFAULT 'UNPAID';

-- Duplicate values would make the CREATE UNIQUE INDEX below fail with a message
-- that names an index rather than the problem. Say the problem. (On a first
-- apply the column is brand new and entirely NULL, so this cannot fire; it
-- exists for a re-run after a partial hand-edit.)
DO $do$
DECLARE
  dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT "paymentIntentId" FROM "bookings"
    WHERE "paymentIntentId" IS NOT NULL
    GROUP BY "paymentIntentId" HAVING count(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE EXCEPTION
      '% payment intent(s) are already attached to more than one booking. That means one captured payment produced several bookings — resolve by hand BEFORE adding the unique index; do not delete a booking a farmer paid for without checking the refund first.', dupes;
  END IF;
END
$do$;

-- Prisma's own name for a @unique field index (<table>_<col>_key). It has to
-- match exactly, or the next `db push` on a dev database creates a duplicate
-- alongside. NULLs are distinct in a btree unique index, so the unpaid legacy
-- path can keep inserting unlimited rows with paymentIntentId NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_paymentIntentId_key"
  ON "bookings"("paymentIntentId");

-- ── Prove it, or undo it ──────────────────────────────────────────────────────
-- Inside the transaction on purpose: a failure here rolls back everything above,
-- so nobody ends up with three of the four columns and a green log.
DO $do$
DECLARE
  cols int;
  idx  int;
  bad  int;
BEGIN
  SELECT count(*) INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'bookings'
    AND column_name IN ('advanceAmount', 'paidAmount', 'paymentIntentId', 'paymentStatus');

  SELECT count(*) INTO idx
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'bookings'
    AND indexname = 'bookings_paymentIntentId_key';

  -- Every pre-existing booking must read as unpaid. If the defaults had not
  -- taken, a NULL paymentStatus would render as an unknown state in the app and
  -- Prisma would reject the row on read (the field is non-nullable).
  SELECT count(*) INTO bad FROM "bookings"
  WHERE "paymentStatus" IS NULL OR "paidAmount" IS NULL;

  IF cols <> 4 THEN RAISE EXCEPTION 'expected 4 new columns on bookings, found %', cols; END IF;
  IF idx  <> 1 THEN RAISE EXCEPTION 'expected the unique index bookings_paymentIntentId_key, found %', idx; END IF;
  IF bad  <> 0 THEN RAISE EXCEPTION '% bookings rows have a NULL paymentStatus or paidAmount', bad; END IF;

  RAISE NOTICE 'bookings: 4 columns + 1 unique index present, every row reads as unpaid';
END
$do$;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- Only after the code has been reverted, and only while no booking has been paid
-- for — once `paidAmount` is non-zero anywhere, dropping these columns destroys
-- the only record that money was collected against that booking. Check first:
--   SELECT count(*) FROM "bookings" WHERE "paymentIntentId" IS NOT NULL;
-- Reverting the code alone is normally enough: unused columns cost nothing, and
-- leaving them makes a re-apply a no-op.
--
--   BEGIN;
--   DROP INDEX IF EXISTS "bookings_paymentIntentId_key";
--   ALTER TABLE "bookings"
--     DROP COLUMN IF EXISTS "advanceAmount",
--     DROP COLUMN IF EXISTS "paidAmount",
--     DROP COLUMN IF EXISTS "paymentIntentId",
--     DROP COLUMN IF EXISTS "paymentStatus";
--   COMMIT;
