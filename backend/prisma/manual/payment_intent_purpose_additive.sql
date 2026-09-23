-- payment_intents.purpose / refType / refId / metadata — additive schema,
-- safe to apply MANUALLY in production. PAY-001.
--
-- WHY MANUAL: the Railway deploy runs `prisma db push`, which makes the DB match
-- schema.prisma EXACTLY and therefore tries to DROP the FastAPI-owned tables it
-- doesn't know about (ai_scan_diagnoses, ai_scan_feedback). Once those hold
-- data, db push aborts ("data loss") and NONE of the schema applies — so these
-- columns would silently never land. This script applies only the additive
-- change. NEVER add --accept-data-loss to the deploy.
--
-- WHAT IT ENABLES: PaymentIntent was AgriStore-shaped — cartHash, quoteSnapshot
-- and orderId are all shop concepts — so rent bookings, AI credit packs and any
-- later flow had nowhere to say what the money was FOR. `purpose` is the
-- discriminator the webhook dispatches on and the reconciler filters by. Until
-- it exists, a rent payment that is merely slow would be swept by the shop
-- reconciler, have its (non-existent) stock reservations released, and be
-- auto-refunded after 30 minutes.
--
-- SAFETY PROPERTIES
--   * Additive only. No DROP, no RENAME, no type change to an existing column.
--   * `purpose` is NOT NULL DEFAULT 'SHOP_ORDER'. Every row already in this
--     table IS an AgriStore checkout — that is the only flow that has ever
--     written it — so the default is the truth, not a placeholder, and no
--     backfill is needed. On Postgres 11+ ADD COLUMN with a constant default
--     is a catalog-only change: no table rewrite, no long lock.
--   * Idempotent. Safe to re-run; re-running changes nothing.
--   * Self-verifying. The final block re-reads the catalog and ABORTS THE WHOLE
--     TRANSACTION if the end state is not exactly what schema.prisma expects,
--     so a partial apply cannot be mistaken for a successful one.
--   * lock_timeout is 3s. payment_intents is on the checkout path; if a long
--     transaction holds a conflicting lock this fails fast and is retried,
--     rather than queueing and blocking every payment behind it.
--
-- ORDER OF OPERATIONS — THIS MATTERS:
--   1. Apply THIS script.
--   2. THEN deploy the code.
--   Reversing them breaks production: Prisma selects every scalar field it
--   knows about, so code that knows `purpose` issues SELECT ... "purpose" ...
--   against a table without it, and every payment read fails with 42703
--   (undefined_column). The other order is harmless — old code simply never
--   mentions the new columns.
--
-- APPLY (any one):
--   cd backend && DATABASE_URL=<prod> npx prisma db execute --file prisma/manual/payment_intent_purpose_additive.sql --schema prisma/schema.prisma
--   psql "$DATABASE_URL" -f backend/prisma/manual/payment_intent_purpose_additive.sql
--   Railway -> Postgres service -> Data/Query tab -> paste + run
--
-- ON A VERY LARGE payment_intents TABLE: the two CREATE INDEX statements take a
-- SHARE lock (blocking writes) for their duration. This table holds one row per
-- checkout attempt, so that is milliseconds. If it ever is not, create the two
-- indexes CONCURRENTLY first — outside any transaction, they cannot run inside
-- one — and this script will then find them present and skip them:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_intents_purpose_status_createdAt_idx" ON "payment_intents"("purpose", "status", "createdAt");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_intents_refType_refId_idx" ON "payment_intents"("refType", "refId");

-- ── 1. The enum type ─────────────────────────────────────────────────────────
-- Created whole, and OUTSIDE the transaction below. A new enum value cannot be
-- used in the same transaction that adds it, so creating the type separately
-- and completely is what lets DEFAULT 'SHOP_ORDER' work in step 2.
--
-- If the type already exists but is missing values, this does NOT quietly patch
-- it: an enum with an unexpected set of values means something else created it,
-- and guessing is worse than stopping.
DO $do$
DECLARE
  missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentPurpose') THEN
    CREATE TYPE "PaymentPurpose" AS ENUM ('SHOP_ORDER', 'RENT_BOOKING', 'AI_CREDITS', 'ANIMAL_TOKEN');
    RAISE NOTICE 'created type PaymentPurpose';
  ELSE
    SELECT string_agg(v, ', ') INTO missing
    FROM unnest(ARRAY['SHOP_ORDER', 'RENT_BOOKING', 'AI_CREDITS', 'ANIMAL_TOKEN']) AS v
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'PaymentPurpose' AND e.enumlabel = v
    );
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION
        'type PaymentPurpose exists but is missing value(s): %. Add each one in its own statement, OUTSIDE a transaction, in schema.prisma order, then re-run this script.', missing;
    END IF;
    RAISE NOTICE 'type PaymentPurpose already present and complete';
  END IF;
END
$do$;

-- ── 2. Columns + indexes, all or nothing ─────────────────────────────────────
BEGIN;

SET LOCAL lock_timeout = '3s';

-- The payments block has no migration folder and reached each environment by
-- `db push`, so it is not safe to assume the table is here. A clear refusal
-- beats "relation payment_intents does not exist" three screens into a deploy.
DO $do$
BEGIN
  IF to_regclass('public.payment_intents') IS NULL THEN
    RAISE EXCEPTION
      'table payment_intents does not exist in this database. The whole shop-hardening block (payment_intents, payment_webhook_events, stock_reservations, ...) has never been applied here — see docs/SHOP_HARDENING.md. Apply that first; this script only extends an existing table.';
  END IF;
END
$do$;

-- A column that already exists with the WRONG type would be silently skipped by
-- ADD COLUMN IF NOT EXISTS, leaving the database and Prisma disagreeing — and
-- the failure would surface at runtime, in the payment path. Check instead.
DO $do$
DECLARE
  actual text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO actual
  FROM pg_attribute a
  WHERE a.attrelid = 'public.payment_intents'::regclass
    AND a.attname = 'purpose' AND a.attnum > 0 AND NOT a.attisdropped;

  IF actual IS NOT NULL AND actual <> '"PaymentPurpose"' THEN
    RAISE EXCEPTION
      'payment_intents.purpose already exists with type % — expected "PaymentPurpose". Resolve by hand; this script will not convert a column on a live payments table.', actual;
  END IF;
END
$do$;

ALTER TABLE "payment_intents"
  ADD COLUMN IF NOT EXISTS "purpose"  "PaymentPurpose" NOT NULL DEFAULT 'SHOP_ORDER',
  ADD COLUMN IF NOT EXISTS "refType"  TEXT,
  ADD COLUMN IF NOT EXISTS "refId"    TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Names are Prisma's own (<table>_<col>_<col>_idx). They have to match exactly,
-- or the next `db push` on a dev database creates a duplicate alongside.
CREATE INDEX IF NOT EXISTS "payment_intents_purpose_status_createdAt_idx"
  ON "payment_intents"("purpose", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "payment_intents_refType_refId_idx"
  ON "payment_intents"("refType", "refId");

-- ── 3. Prove it, or undo it ──────────────────────────────────────────────────
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
  WHERE table_schema = 'public' AND table_name = 'payment_intents'
    AND column_name IN ('purpose', 'refType', 'refId', 'metadata');

  SELECT count(*) INTO idx
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'payment_intents'
    AND indexname IN ('payment_intents_purpose_status_createdAt_idx', 'payment_intents_refType_refId_idx');

  -- Every pre-existing row must read as SHOP_ORDER. If the default had not
  -- taken, those intents would dispatch to no handler and stop being served.
  SELECT count(*) INTO bad FROM "payment_intents" WHERE "purpose" IS NULL;

  IF cols <> 4 THEN RAISE EXCEPTION 'expected 4 new columns on payment_intents, found %', cols; END IF;
  IF idx  <> 2 THEN RAISE EXCEPTION 'expected 2 new indexes on payment_intents, found %', idx;  END IF;
  IF bad  <> 0 THEN RAISE EXCEPTION '% payment_intents rows have a NULL purpose', bad;          END IF;

  RAISE NOTICE 'payment_intents: 4 columns + 2 indexes present, every row has a purpose';
END
$do$;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- Only after the code has been reverted, and only before PAY-002 ships — once
-- rent intents exist, dropping `purpose` destroys the only record of what those
-- payments were for. Reverting the code alone is normally enough: unused
-- columns cost nothing, and leaving them makes a re-apply a no-op.
--
--   BEGIN;
--   DROP INDEX IF EXISTS "payment_intents_purpose_status_createdAt_idx";
--   DROP INDEX IF EXISTS "payment_intents_refType_refId_idx";
--   ALTER TABLE "payment_intents"
--     DROP COLUMN IF EXISTS "purpose",
--     DROP COLUMN IF EXISTS "refType",
--     DROP COLUMN IF EXISTS "refId",
--     DROP COLUMN IF EXISTS "metadata";
--   DROP TYPE IF EXISTS "PaymentPurpose";
--   COMMIT;
