-- Seller delivery, phases 1 and 4 (docs/SELLER_DELIVERY_DESIGN.md §8.6).
--
-- WHY: a seller marked an order delivered with one tap and nothing from the
-- farmer, and an order the farmer refused at the door stayed SHIPPED for ever.
-- `order_deliveries` holds, per seller per order, the 4-digit proof-of-delivery
-- code, the wrong-try counter and lock, how the order was delivered, and why a
-- delivery failed. NEW_ORDER is the in-app notification behind the "you have a
-- new order" push to a seller.
--
-- PURELY ADDITIVE. One new table, one new enum value; no drop, no rename, no
-- change to an existing column, no backfill:
--   * No foreign keys. The table refers to orders and users by plain id (the
--     same choice as return_requests), so creating it locks nothing existing.
--     Orders are never deleted, so there is nothing to cascade.
--   * `code` is TEXT: it stores AES-256-GCM ciphertext, never the four digits.
--     Nullable — a delivery made without a code never had one.
--   * `codeAttempts` is NOT NULL DEFAULT 0 and `codeLockedUntil` is nullable;
--     together they are the lock. The counter is advanced by one atomic UPDATE
--     outside the status transaction, so a refused attempt still counts.
--   * `codAmountDue`, `codCollectedAmount`, `codCollectedAt` are for phase 5
--     (recording cash on delivery) and are unused until then. They exist now so
--     that phase is a code change only.
--   * The unique index on ("orderId", "sellerId") is the only index besides the
--     primary key. It makes "one delivery, one code, per seller per order" a
--     database guarantee, and its leading column serves "the deliveries of
--     these orders" for the farmer's order list.
--
-- See prisma/manual/seller_delivery_additive.sql for the prod-apply variant
-- (idempotent and self-verifying). The deploy runs `prisma db push`, which
-- cannot be used against production: it would try to drop the FastAPI-owned
-- tables it does not know about (ai_scan_diagnoses, ai_scan_feedback), abort on
-- data loss, and then NONE of this would land.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'NEW_ORDER';

-- CreateTable
CREATE TABLE "order_deliveries" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "code" TEXT,
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "codeLockedUntil" TIMESTAMP(3),
    "deliveredVia" TEXT,
    "noCodeReason" TEXT,
    "failedReason" TEXT,
    "codAmountDue" DECIMAL(12,2),
    "codCollectedAmount" DECIMAL(12,2),
    "codCollectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_deliveries_orderId_sellerId_key" ON "order_deliveries"("orderId", "sellerId");
