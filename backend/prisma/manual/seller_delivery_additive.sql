-- Seller delivery (phases 1 and 4) — table order_deliveries + one enum value.
-- Additive schema, safe to apply MANUALLY in production.
-- Contract: docs/SELLER_DELIVERY_DESIGN.md §8.6.
--
-- WHY MANUAL: nothing in the deploy changes the schema. The VPS runs the image
-- built from the root Dockerfile, started with `node src/server.js` and nothing
-- else (deploy/docker-compose.yml) — no `prisma db push`, no `prisma migrate
-- deploy`. So this script is the ONLY way the table reaches an existing database.
--
-- Do not "fix" that by adding a db push to the start command. db push makes the
-- DB match schema.prisma EXACTLY and therefore tries to DROP the FastAPI-owned
-- tables it doesn't know about (ai_scan_diagnoses, ai_scan_feedback). NEVER use
-- --accept-data-loss against production.
--
-- WHAT IT ENABLES
--   1. `order_deliveries` — one row per seller per order. Holds the 4-digit
--      proof-of-delivery code (encrypted by the application before it gets
--      here), the wrong-try counter and lock, how the order was delivered, and
--      why a delivery failed. Three cash-on-delivery columns are created now and
--      left unused until phase 5, so that phase needs no second schema change.
--   2. `NEW_ORDER` on the "NotificationType" enum — the in-app notification row
--      behind the "you have a new order" push to a seller. The push to the phone
--      does not depend on it; the row in the app's inbox does.
--
-- SAFETY PROPERTIES
--   * Additive only. One new table, one new enum value. No DROP, no RENAME, no
--     change to any existing column, and NO foreign key: the new table refers to
--     orders and users by plain id (as return_requests does), so creating it
--     takes no lock on `orders` or `users` at all. Nothing existing is rewritten.
--   * Idempotent. Safe to re-run; re-running changes nothing.
--   * Self-verifying. The final block re-reads the catalog and ABORTS THE WHOLE
--     TRANSACTION if the end state is not exactly what schema.prisma expects —
--     every column's type, nullability and default, the primary key, the one
--     unique index and its column order — so a partial or hand-edited table
--     cannot be mistaken for a correct one.
--   * A table that already exists with a WRONG column type is refused up front
--     rather than silently skipped by CREATE TABLE IF NOT EXISTS.
--   * lock_timeout is 3s. The only contended object here is the enum type
--     (ALTER TYPE takes a brief exclusive lock on it); if something holds it,
--     this fails fast and is retried instead of queueing behind it.
--   * Needs PostgreSQL 12 or newer: ALTER TYPE … ADD VALUE is not allowed inside
--     a transaction block before that. (The new value is not USED inside this
--     transaction, which is the one restriction that remains.)
--
-- ORDER OF OPERATIONS:
--   1. Apply THIS script.
--   2. THEN deploy the code.
--   The other order breaks nothing, but it leaves the feature OFF. The code asks
--   whether the table exists (deliveryTableReady() in
--   services/orderDelivery.service.js) and, while it does not, stands aside:
--   no delivery code is issued or demanded, "could not deliver" is refused as
--   before, orders ship and deliver exactly as they did, and an ERROR line in
--   the log says the script is missing. It re-checks every 30 seconds, so
--   applying the script afterwards switches the feature on without a restart.
--   Until the enum value exists, a seller's new-order push still reaches the
--   phone but leaves no row in the in-app inbox.
--   One thing does need the script first: the encryption key-rotation script
--   (npm run rotate:keys) now lists order_deliveries.code and fails without it.
--
-- APPLY (any one):
--   cd backend && DATABASE_URL=<prod> npx prisma db execute --file prisma/manual/seller_delivery_additive.sql --schema prisma/schema.prisma
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/prisma/manual/seller_delivery_additive.sql
--     (without ON_ERROR_STOP psql exits 0 even when the check at the end aborts)
--   On the VPS, over SSH (Postgres has no public port; ks_app owns the tables):
--     cd /opt/krushisarva
--     docker compose exec -T postgres sh -c 'psql -U ks_app -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--       < app/backend/prisma/manual/seller_delivery_additive.sql
--   (The VPS database, built by `prisma db push` on 2026-10-14, already has this.)

BEGIN;

SET LOCAL lock_timeout = '3s';

-- A clear refusal beats a cryptic one three screens into a deploy. Nothing below
-- references `orders` by constraint, but a database without it is not the
-- KrushiSarva database, and the enum must exist to be extended.
DO $do$
BEGIN
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION
      'table orders does not exist in this database. This script only extends an existing schema — apply the base schema first.';
  END IF;
  IF to_regtype('public."NotificationType"') IS NULL THEN
    RAISE EXCEPTION
      'enum type "NotificationType" does not exist in this database. This script only extends an existing schema — apply the base schema first.';
  END IF;
END
$do$;

-- CREATE TABLE IF NOT EXISTS skips an existing table whatever it looks like. If
-- one is already there with a column of the wrong type, say so now: the failure
-- would otherwise surface at runtime, on a seller's "Mark shipped".
DO $do$
DECLARE
  r      record;
  actual text;
BEGIN
  IF to_regclass('public.order_deliveries') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('id',                 'text'),
      ('orderId',            'text'),
      ('sellerId',           'text'),
      ('code',               'text'),
      ('codeAttempts',       'integer'),
      ('codeLockedUntil',    'timestamp(3) without time zone'),
      ('deliveredVia',       'text'),
      ('noCodeReason',       'text'),
      ('failedReason',       'text'),
      ('codAmountDue',       'numeric(12,2)'),
      ('codCollectedAmount', 'numeric(12,2)'),
      ('codCollectedAt',     'timestamp(3) without time zone'),
      ('createdAt',          'timestamp(3) without time zone'),
      ('updatedAt',          'timestamp(3) without time zone')
    ) AS v(col, expected)
  LOOP
    SELECT format_type(a.atttypid, a.atttypmod) INTO actual
    FROM pg_attribute a
    WHERE a.attrelid = 'public.order_deliveries'::regclass
      AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped;

    IF actual IS NOT NULL AND actual <> r.expected THEN
      RAISE EXCEPTION
        'order_deliveries.% already exists with type % — expected %. Resolve by hand; this script will not convert a column.',
        r.col, actual, r.expected;
    END IF;
  END LOOP;
END
$do$;

-- Exactly what `prisma migrate` would emit for model OrderDelivery. Column
-- names, types and the constraint name have to match, or the next `db push` on
-- a dev database sees drift and tries to "fix" it.
--
--   code            TEXT, not CHAR(4): it stores AES-256-GCM ciphertext, never
--                   the four digits.
--   codAmountDue…   DECIMAL(12,2) like every other money column. Unused until
--                   phase 5; created now so that phase is code-only.
--   updatedAt       NOT NULL with no default — Prisma's @updatedAt sets it on
--                   every write, and the one raw UPDATE that touches this table
--                   sets it explicitly.
CREATE TABLE IF NOT EXISTS "order_deliveries" (
    "id"                 TEXT NOT NULL,
    "orderId"            TEXT NOT NULL,
    "sellerId"           TEXT NOT NULL,
    "code"               TEXT,
    "codeAttempts"       INTEGER NOT NULL DEFAULT 0,
    "codeLockedUntil"    TIMESTAMP(3),
    "deliveredVia"       TEXT,
    "noCodeReason"       TEXT,
    "failedReason"       TEXT,
    "codAmountDue"       DECIMAL(12, 2),
    "codCollectedAmount" DECIMAL(12, 2),
    "codCollectedAt"     TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_deliveries_pkey" PRIMARY KEY ("id")
);

-- Duplicate (orderId, sellerId) pairs would make the CREATE UNIQUE INDEX below
-- fail with a message that names an index rather than the problem. Say the
-- problem. (On a first apply the table is brand new and empty, so this cannot
-- fire; it exists for a re-run after a hand-edit.)
DO $do$
DECLARE
  dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT "orderId", "sellerId" FROM "order_deliveries"
    GROUP BY "orderId", "sellerId" HAVING count(*) > 1
  ) d;

  IF dupes > 0 THEN
    RAISE EXCEPTION
      '% (order, seller) pair(s) already have more than one order_deliveries row. Two rows means two delivery codes for one shipment — resolve by hand BEFORE adding the unique index.', dupes;
  END IF;
END
$do$;

-- Prisma's own name for @@unique([orderId, sellerId]). It is the ONLY index
-- besides the primary key, on purpose (§8.6): every read is "this seller's
-- delivery of this order" or, by its leading column, "the deliveries of these
-- orders" — and it is what makes "one code per shipment" a database guarantee
-- rather than a code convention.
CREATE UNIQUE INDEX IF NOT EXISTS "order_deliveries_orderId_sellerId_key"
  ON "order_deliveries"("orderId", "sellerId");

-- The seller's "new order" notification type. IF NOT EXISTS makes the re-run a
-- no-op. Appended at the end of the enum, which is where schema.prisma lists it.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NEW_ORDER';

-- ── Prove it, or undo it ──────────────────────────────────────────────────────
-- Inside the transaction on purpose: a failure here rolls back everything above,
-- so nobody ends up with half a table and a green log.
DO $do$
DECLARE
  r       record;
  actual  record;
  cols    int;
  pk      text;
  uq      text;
  extra   int;
  enumval int;
BEGIN
  -- Every column: type, nullability, and whether it has a default.
  FOR r IN
    SELECT * FROM (VALUES
      ('id',                 'text',                           true,  false),
      ('orderId',            'text',                           true,  false),
      ('sellerId',           'text',                           true,  false),
      ('code',               'text',                           false, false),
      ('codeAttempts',       'integer',                        true,  true),
      ('codeLockedUntil',    'timestamp(3) without time zone', false, false),
      ('deliveredVia',       'text',                           false, false),
      ('noCodeReason',       'text',                           false, false),
      ('failedReason',       'text',                           false, false),
      ('codAmountDue',       'numeric(12,2)',                  false, false),
      ('codCollectedAmount', 'numeric(12,2)',                  false, false),
      ('codCollectedAt',     'timestamp(3) without time zone', false, false),
      ('createdAt',          'timestamp(3) without time zone', true,  true),
      ('updatedAt',          'timestamp(3) without time zone', true,  false)
    ) AS v(col, expected_type, expected_notnull, expected_default)
  LOOP
    SELECT format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS notnull, a.atthasdef AS hasdef
      INTO actual
    FROM pg_attribute a
    WHERE a.attrelid = 'public.order_deliveries'::regclass
      AND a.attname = r.col AND a.attnum > 0 AND NOT a.attisdropped;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_deliveries.% is missing', r.col;
    END IF;
    IF actual.typ <> r.expected_type THEN
      RAISE EXCEPTION 'order_deliveries.% has type %, expected %', r.col, actual.typ, r.expected_type;
    END IF;
    IF actual.notnull <> r.expected_notnull THEN
      RAISE EXCEPTION 'order_deliveries.% NOT NULL is %, expected %', r.col, actual.notnull, r.expected_notnull;
    END IF;
    IF actual.hasdef <> r.expected_default THEN
      RAISE EXCEPTION 'order_deliveries.% has-a-default is %, expected %', r.col, actual.hasdef, r.expected_default;
    END IF;
  END LOOP;

  -- And nothing else. An unexpected extra column means this is not the table
  -- schema.prisma describes, whatever the 14 above look like.
  SELECT count(*) INTO cols
  FROM pg_attribute a
  WHERE a.attrelid = 'public.order_deliveries'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols <> 14 THEN
    RAISE EXCEPTION 'expected exactly 14 columns on order_deliveries, found %', cols;
  END IF;

  -- The counter must start at zero: a NULL or non-zero default would either
  -- break `codeAttempts + 1` or hand a new delivery fewer than five attempts.
  IF (SELECT pg_get_expr(d.adbin, d.adrelid)
        FROM pg_attrdef d
        JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.order_deliveries'::regclass AND a.attname = 'codeAttempts') <> '0' THEN
    RAISE EXCEPTION 'order_deliveries.codeAttempts must default to 0';
  END IF;

  -- Primary key on (id), under Prisma's name.
  SELECT pg_get_constraintdef(c.oid) INTO pk
  FROM pg_constraint c
  WHERE c.conrelid = 'public.order_deliveries'::regclass
    AND c.contype = 'p' AND c.conname = 'order_deliveries_pkey';
  IF pk IS DISTINCT FROM 'PRIMARY KEY (id)' THEN
    RAISE EXCEPTION 'expected PRIMARY KEY (id) named order_deliveries_pkey, found %', coalesce(pk, '(none)');
  END IF;

  -- The unique index: unique, valid, and on ("orderId", "sellerId") IN THAT
  -- ORDER. The order is load-bearing — reads by orderId alone ride its prefix.
  SELECT pg_get_indexdef(i.indexrelid) INTO uq
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid = 'public.order_deliveries'::regclass
    AND ic.relname = 'order_deliveries_orderId_sellerId_key'
    AND i.indisunique AND i.indisvalid;
  IF uq IS NULL OR uq NOT LIKE '%("orderId", "sellerId")' THEN
    RAISE EXCEPTION 'expected a valid UNIQUE index order_deliveries_orderId_sellerId_key on ("orderId", "sellerId"), found %', coalesce(uq, '(none)');
  END IF;

  -- No other index (§8.6). One that Prisma does not know about is drift that
  -- the next db push on a dev database would try to drop.
  SELECT count(*) INTO extra
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid = 'public.order_deliveries'::regclass
    AND ic.relname NOT IN ('order_deliveries_pkey', 'order_deliveries_orderId_sellerId_key');
  IF extra <> 0 THEN
    RAISE EXCEPTION 'order_deliveries has % unexpected extra index(es)', extra;
  END IF;

  SELECT count(*) INTO enumval
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'NotificationType' AND e.enumlabel = 'NEW_ORDER';
  IF enumval <> 1 THEN
    RAISE EXCEPTION 'expected the value NEW_ORDER on enum "NotificationType", found % match(es)', enumval;
  END IF;

  RAISE NOTICE 'order_deliveries: 14 columns, primary key and 1 unique index present; NotificationType has NEW_ORDER';
END
$do$;

COMMIT;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- Reverting the CODE is the rollback, and is normally all that is needed: with
-- `shop.delivery.codeRequired` off (its default) nothing demands a code, and an
-- unused table and an unused enum value cost nothing. Leaving them also makes a
-- re-apply a no-op.
--
-- Only if the table itself must go — after the code has been reverted, and
-- knowing that it deletes the record of HOW every order was delivered and why
-- any delivery failed. Check what is in it first:
--   SELECT count(*), count("deliveredVia"), count("failedReason") FROM "order_deliveries";
--
--   BEGIN;
--   DROP TABLE IF EXISTS "order_deliveries";
--   COMMIT;
--
-- The enum value is NOT removed: PostgreSQL has no ALTER TYPE … DROP VALUE, and
-- once a notification row uses NEW_ORDER removing it would mean rebuilding the
-- type. An unused label is harmless.
