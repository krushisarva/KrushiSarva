/**
 * The lot ledger: ProductBatch.quantity.
 *
 * SellerListing.stockQty says HOW MANY units a Kendra can sell; the batch rows say
 * WHICH physical lots make that number up. Nothing reduced the lot rows, so
 * first-expiry-first allocation handed every order the same earliest-expiring lot
 * for ever, and a recall of the lot that actually shipped found none of its
 * buyers — order_items.batchNumber pointed at a lot that had long since gone.
 *
 * These tests pin the ledger to the order: an allocation draws the lot down, a
 * cancel puts it back, and it never goes negative even when the seller's own lot
 * bookkeeping does not add up to the stock they are selling.
 */
import request from 'supertest';
import {
  getApp, createTestUser, createTestSeller, createTestCategory,
  createTestCatalogProduct, createTestListing, cleanupTestData, prisma,
} from '../../fixtures/setup.js';

const API = '/api/v1/agristore';

const address = {
  type: 'HOME', name: 'Lot Buyer', phone: '9876543210',
  flat: '1A', street: 'Main', city: 'Pune', state: 'Maharashtra', pincode: '411001',
};

let app; let farmer; let seller; let category;

const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000);

beforeAll(async () => {
  app = await getApp();
  farmer = await createTestUser({ district: 'Pune', state: 'Maharashtra' });
  seller = await createTestSeller({ district: 'Pune', state: 'Maharashtra' });
  category = await createTestCategory({ name: `Lot Ledger ${Date.now()}`, isRegulated: true });
  // Every regulated class these tests sell needs a live licence, or the sale is
  // refused before allocation is ever reached.
  for (const kind of ['INSECTICIDE', 'FUNGICIDE', 'HERBICIDE']) {
    await prisma.sellerLicence.upsert({
      where: { sellerId_kind: { sellerId: seller.user.id, kind } },
      create: { sellerId: seller.user.id, kind, licenceNumber: 'LIC-LOT', status: 'APPROVED', validTo: daysFromNow(365) },
      update: { status: 'APPROVED', validTo: daysFromNow(365) },
    });
  }
}, 60_000);

afterAll(async () => { await cleanupTestData(); });

/**
 * A regulated offer with `lots` recorded against it. `lots` is given
 * out of expiry order on purpose — FEFO must come from the expiry date, not from
 * insertion order.
 */
async function regulatedOffer({ stockQty = 20, kind = 'INSECTICIDE', lots = [], requiresExpiry = true } = {}) {
  const product = await createTestCatalogProduct(category.id, { name: `Lot Seed ${Date.now()}-${Math.random()}` });
  const listing = await createTestListing(seller.user.id, product.variants[0].id, {
    sellingPrice: 100, stockQty, district: 'Pune', state: 'Maharashtra',
  });
  await prisma.productCompliance.create({
    data: {
      productId: product.id,
      regulatedKind: kind,
      status: 'APPROVED',
      registrationNumber: 'CIR-99999/2024',
      registrationAuthority: 'CIB&RC',
      labelVersion: 'v1',
      requiresBatch: true,
      requiresExpiry,
      minShelfLifeDays: 30,
    },
  });
  if (lots.length) {
    await prisma.productBatch.createMany({
      data: lots.map((l) => ({
        listingId: listing.id, sellerId: seller.user.id,
        batchNumber: l.batchNumber, quantity: l.quantity,
        ...(l.status ? { status: l.status } : {}),
        expiryDate: l.expiresInDays == null ? null : daysFromNow(l.expiresInDays),
      })),
    });
  }
  return { product, listing };
}

async function fillCart(buyer, listing, product, quantity) {
  await prisma.cartItem.deleteMany({ where: { userId: buyer.user.id } });
  await prisma.cartItem.create({
    data: {
      userId: buyer.user.id, listingId: listing.id, productId: product.id,
      quantity, unitPriceSnapshot: 100,
    },
  });
}

async function codOrder(buyer, listing, product, quantity) {
  await fillCart(buyer, listing, product, quantity);
  const res = await request(app).post(`${API}/orders`).set(buyer.headers)
    .send({ paymentMethod: 'cod', deliveryAddress: address });
  expect(res.status).toBe(201);
  return res.body.data;
}

/** The lot rows of one offer, keyed by batch number. */
async function lotsOf(listingId) {
  const rows = await prisma.productBatch.findMany({ where: { listingId } });
  return Object.fromEntries(rows.map((r) => [r.batchNumber, r.quantity]));
}

const lineOf = (orderId) => prisma.orderItem.findFirst({ where: { orderId } });

/** Every unit the offer's lots account for, across all of them. */
const lotTotal = async (listingId) =>
  Object.values(await lotsOf(listingId)).reduce((a, b) => a + b, 0);

describe('Allocating an order draws its lots down', () => {
  test('an order spanning two lots decrements both, earliest expiry first', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      lots: [
        { batchNumber: 'LATE', quantity: 10, expiresInDays: 500 },
        { batchNumber: 'EARLY', quantity: 4, expiresInDays: 200 },
      ],
    });

    const order = await codOrder(farmer, listing, product, 6);

    // EARLY is emptied before LATE is touched at all.
    expect(await lotsOf(listing.id)).toEqual({ EARLY: 0, LATE: 8 });
    // The line is stamped with the lot it was drawn from first, which is the one
    // a recall of short-dated stock has to be able to find.
    expect((await lineOf(order.id)).batchNumber).toBe('EARLY');
    // stockQty stays the authoritative sellable number and is untouched by this.
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(14);
  });

  test('the next order is stamped with the next lot once the first is exhausted', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      lots: [
        { batchNumber: 'EARLY', quantity: 2, expiresInDays: 200 },
        { batchNumber: 'LATE', quantity: 10, expiresInDays: 500 },
      ],
    });

    const first = await codOrder(farmer, listing, product, 2);
    expect((await lineOf(first.id)).batchNumber).toBe('EARLY');

    const second = await codOrder(farmer, listing, product, 3);

    // The whole bug in one assertion: before the ledger moved, this was EARLY
    // again — a lot the Kendra no longer physically held.
    expect((await lineOf(second.id)).batchNumber).toBe('LATE');
    expect(await lotsOf(listing.id)).toEqual({ EARLY: 0, LATE: 7 });
  });

  test('a lot never goes negative when the lots do not cover the units sold', async () => {
    // The seller has recorded 3 units of lots against an offer of 10. stockQty is
    // what the sale was validated against, so the order must stand.
    const { product, listing } = await regulatedOffer({
      stockQty: 10,
      kind: 'FUNGICIDE',
      lots: [{ batchNumber: 'THIN', quantity: 3, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 5);

    expect(await lotsOf(listing.id)).toEqual({ THIN: 0 });
    expect((await lineOf(order.id)).batchNumber).toBe('THIN');
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(5);
  });

  test('the online paid path draws its lots down too', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'HERBICIDE',
      lots: [{ batchNumber: 'PAID-1', quantity: 10, expiresInDays: 300 }],
    });
    await fillCart(farmer, listing, product, 4);

    const init = await request(app).post(`${API}/orders/initiate`).set(farmer.headers)
      .send({ paymentMethod: 'upi', deliveryAddress: address });
    expect(init.status).toBe(200);

    const done = await request(app).post(`${API}/orders/confirm`).set(farmer.headers).send({
      razorpayOrderId: init.body.data.razorpayOrderId,
      razorpayPaymentId: `pay_lot_${Date.now()}`,
      razorpaySignature: 'x'.repeat(64),
      deliveryAddress: address,
    });
    expect(done.status).toBe(201);

    // The reservation taken at /orders/initiate holds stockQty, never lots, so
    // the lot has to be drawn here — gating it on the hold leaves the paid path
    // with a ledger that never moves.
    expect(await lotsOf(listing.id)).toEqual({ 'PAID-1': 6 });
    expect((await lineOf(done.body.data.id)).batchNumber).toBe('PAID-1');
  });
});

describe('Cancelling an order returns its units to the lot', () => {
  test('a buyer cancel puts the units back on the lot they came from', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      lots: [{ batchNumber: 'BACK-1', quantity: 10, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 3);
    expect(await lotsOf(listing.id)).toEqual({ 'BACK-1': 7 });

    const res = await request(app).put(`${API}/orders/${order.id}/cancel`).set(farmer.headers).send();
    expect(res.status).toBe(200);

    // Mirrors the stock restock: the shelf and the ledger go back together, or
    // the offer walks its lots down to zero and drops out of allocation.
    expect(await lotsOf(listing.id)).toEqual({ 'BACK-1': 10 });
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(20);
  });

  test('a seller cancel puts the units back on the lot too', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'FUNGICIDE',
      lots: [{ batchNumber: 'BACK-2', quantity: 10, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 2);
    expect(await lotsOf(listing.id)).toEqual({ 'BACK-2': 8 });

    const res = await request(app).put(`${API}/seller/orders/${order.id}/status`)
      .set(seller.headers).send({ status: 'CANCELLED' });
    expect(res.status).toBe(200);

    expect(await lotsOf(listing.id)).toEqual({ 'BACK-2': 10 });
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(20);
  });

  test('a cancel credits back what was DRAWN, not what the line says', async () => {
    // The seller has recorded 3 units of lots against an offer of 10, so the
    // order draws the 3 that exist and stockQty carries the other 2 (see "a lot
    // never goes negative" above). The cancel must put back those 3.
    //
    // Crediting the LINE quantity put 5 back on a lot that had only ever held 3
    // — two units minted onto a shelf the Kendra does not physically have, which
    // FEFO then went on allocating and a recall then over-reported. stockQty is
    // the oversell guarantee and is unaffected either way; what breaks is the
    // lot ledger's account of the physical shelf.
    const { product, listing } = await regulatedOffer({
      stockQty: 10,
      kind: 'FUNGICIDE',
      lots: [{ batchNumber: 'THIN-BACK', quantity: 3, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 5);
    expect(await lotsOf(listing.id)).toEqual({ 'THIN-BACK': 0 });

    const res = await request(app).put(`${API}/orders/${order.id}/cancel`).set(farmer.headers).send();
    expect(res.status).toBe(200);

    expect(await lotsOf(listing.id)).toEqual({ 'THIN-BACK': 3 });
    // The shelf number is restored in full regardless: it is what was decremented.
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(10);
  });

  test('a SELLER cancel of an under-covered line puts back only what was drawn too', async () => {
    // Both cancel paths reach restoreOrderBatches, and the seller path reads its
    // lines through an explicit `select` — a column left out of it is silently
    // undefined, which reads back as "no record" and falls straight through to
    // the line quantity. The over-credit would survive on this path alone.
    const { product, listing } = await regulatedOffer({
      stockQty: 10,
      kind: 'HERBICIDE',
      lots: [{ batchNumber: 'THIN-SELLER', quantity: 3, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 5);
    expect(await lotsOf(listing.id)).toEqual({ 'THIN-SELLER': 0 });

    const res = await request(app).put(`${API}/seller/orders/${order.id}/status`)
      .set(seller.headers).send({ status: 'CANCELLED' });
    expect(res.status).toBe(200);

    expect(await lotsOf(listing.id)).toEqual({ 'THIN-SELLER': 3 });
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(10);
  });

  test('a line spanning two lots restores the right TOTAL to the lot it was stamped with', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'FUNGICIDE',
      lots: [
        { batchNumber: 'SPLIT-EARLY', quantity: 4, expiresInDays: 200 },
        { batchNumber: 'SPLIT-LATE', quantity: 10, expiresInDays: 500 },
      ],
    });

    const order = await codOrder(farmer, listing, product, 6);
    expect(await lotsOf(listing.id)).toEqual({ 'SPLIT-EARLY': 0, 'SPLIT-LATE': 8 });
    expect((await lineOf(order.id)).batchNumber).toBe('SPLIT-EARLY');

    const res = await request(app).put(`${API}/orders/${order.id}/cancel`).set(farmer.headers).send();
    expect(res.status).toBe(200);

    // The DOCUMENTED approximation, deliberately unchanged: order_items carries a
    // single batchNumber, so all six units go back to the lot the line was
    // stamped with and only the per-lot split is approximate. What this fix is
    // about is the TOTAL, which must be the six that were taken — not more.
    expect(await lotTotal(listing.id)).toBe(14);
    expect(await lotsOf(listing.id)).toEqual({ 'SPLIT-EARLY': 6, 'SPLIT-LATE': 8 });
  });

  test('a line written before batchQuantity existed falls back to its line quantity', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      lots: [{ batchNumber: 'LEGACY', quantity: 10, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 3);
    expect(await lotsOf(listing.id)).toEqual({ LEGACY: 7 });

    // Every row that predates the column carries NULL and what it drew is not
    // recoverable from anything that was stored. Blanking it is the only way to
    // put a genuinely pre-existing line through the live cancel path.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { batchQuantity: null } });

    const res = await request(app).put(`${API}/orders/${order.id}/cancel`).set(farmer.headers).send();
    expect(res.status).toBe(200);

    // The line quantity stands in for the missing record: exactly what this order
    // did before the column existed, so nothing in flight changes behaviour, and
    // the right number for every offer whose lots covered its stock.
    expect(await lotsOf(listing.id)).toEqual({ LEGACY: 10 });
  });

  test('a line recorded as having drawn NOTHING credits nothing back', async () => {
    // Zero is a recorded answer, not a missing one: a line whose candidate lots
    // were all gone by the time the checkout transaction re-read them is stamped
    // with the lot the QUOTE picked, but no lot gave up a unit. Treating that
    // zero as "unknown" and falling back to the line quantity would mint the
    // whole line onto a lot that was never touched.
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'HERBICIDE',
      lots: [{ batchNumber: 'UNDRAWN', quantity: 10, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 3);
    expect(await lotsOf(listing.id)).toEqual({ UNDRAWN: 7 });

    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { batchQuantity: 0 } });

    const res = await request(app).put(`${API}/orders/${order.id}/cancel`).set(farmer.headers).send();
    expect(res.status).toBe(200);

    expect(await lotsOf(listing.id)).toEqual({ UNDRAWN: 7 });
    // The shelf still goes back in full — stockQty and the lot ledger answer
    // different questions and only one of them was drawn from.
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(20);
  });

  test('the drawn quantity is recorded on the line at order time', async () => {
    // The column is the whole fix: without it the cancel has nothing to read.
    const covered = await regulatedOffer({
      stockQty: 20,
      lots: [{ batchNumber: 'REC-FULL', quantity: 10, expiresInDays: 300 }],
    });
    const full = await codOrder(farmer, covered.listing, covered.product, 4);
    expect((await lineOf(full.id)).batchQuantity).toBe(4);

    const thin = await regulatedOffer({
      stockQty: 10,
      kind: 'FUNGICIDE',
      lots: [{ batchNumber: 'REC-THIN', quantity: 3, expiresInDays: 300 }],
    });
    const short = await codOrder(farmer, thin.listing, thin.product, 5);
    // Five sold, three drawn: the number the cancel has to give back.
    expect((await lineOf(short.id)).batchQuantity).toBe(3);
    expect((await lineOf(short.id)).quantity).toBe(5);
  });
});

/**
 * Which lots may be drawn from at all.
 *
 * The allocation runs on the candidate set the compliance verdict produced, but
 * it RE-READS each lot's status and quantity inside the checkout transaction —
 * an admin may have quarantined or recalled the lot between the quote and the
 * money changing hands, and held stock never ships.
 */
describe('Held and undated lots', () => {
  test('a QUARANTINED lot is passed over even though it expires first', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      lots: [
        { batchNumber: 'HELD', quantity: 10, expiresInDays: 100, status: 'QUARANTINED' },
        { batchNumber: 'FREE', quantity: 10, expiresInDays: 400 },
      ],
    });

    const order = await codOrder(farmer, listing, product, 3);

    // FEFO would have taken HELD first on expiry alone. Status wins: a lot under
    // quarantine is not stock, and shipping it is the failure the hold exists for.
    expect(await lotsOf(listing.id)).toEqual({ HELD: 10, FREE: 7 });
    expect((await lineOf(order.id)).batchNumber).toBe('FREE');
  });

  test('an EXPIRED lot is passed over and the live one is drawn instead', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'FUNGICIDE',
      lots: [
        { batchNumber: 'GONE', quantity: 10, expiresInDays: -5, status: 'EXPIRED' },
        { batchNumber: 'GOOD', quantity: 10, expiresInDays: 400 },
      ],
    });

    const order = await codOrder(farmer, listing, product, 2);

    expect(await lotsOf(listing.id)).toEqual({ GONE: 10, GOOD: 8 });
    expect((await lineOf(order.id)).batchNumber).toBe('GOOD');
  });

  test('an undated lot is drawn LAST, after every dated one', async () => {
    // Only a product whose label carries no expiry may have an undated lot, so
    // requiresExpiry is off here. FEFO then has to put the unknown date last:
    // Postgres sorts NULLs last on ASC, and the allocation must inherit that.
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'HERBICIDE',
      requiresExpiry: false,
      lots: [
        { batchNumber: 'NODATE', quantity: 5, expiresInDays: null },
        { batchNumber: 'DATED', quantity: 5, expiresInDays: 400 },
      ],
    });

    const order = await codOrder(farmer, listing, product, 7);

    // DATED is emptied first; only the overflow reaches the undated lot.
    expect(await lotsOf(listing.id)).toEqual({ DATED: 0, NODATE: 3 });
    expect((await lineOf(order.id)).batchNumber).toBe('DATED');
  });
});

/**
 * Retries. A village connection times out mid-checkout and the app sends the
 * same order again; a seller taps "Cancel" twice. Neither may move the ledger
 * a second time.
 */
describe('The ledger under retries and repeats', () => {
  test('a retried checkout under the same Idempotency-Key draws the lot down once', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      lots: [{ batchNumber: 'RETRY-1', quantity: 10, expiresInDays: 300 }],
    });
    await fillCart(farmer, listing, product, 3);

    const key = `lot-idem-${Date.now()}`;
    const before = await prisma.order.count({ where: { userId: farmer.user.id } });

    const first = await request(app).post(`${API}/orders`).set(farmer.headers)
      .set('Idempotency-Key', key)
      .send({ paymentMethod: 'cod', deliveryAddress: address });
    expect(first.status).toBe(201);

    // The same send action again: replayed from the idempotency record when Redis
    // is up, refused on the now-empty cart when it is not. Either way exactly one
    // order exists, so the lot must have moved exactly once.
    const second = await request(app).post(`${API}/orders`).set(farmer.headers)
      .set('Idempotency-Key', key)
      .send({ paymentMethod: 'cod', deliveryAddress: address });
    if (second.status === 201) expect(second.body.data.id).toBe(first.body.data.id);

    expect(await prisma.order.count({ where: { userId: farmer.user.id } })).toBe(before + 1);
    expect(await lotsOf(listing.id)).toEqual({ 'RETRY-1': 7 });
  });

  test('a second seller CANCELLED does not credit the lot twice', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'FUNGICIDE',
      lots: [{ batchNumber: 'TWICE', quantity: 10, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 4);
    expect(await lotsOf(listing.id)).toEqual({ TWICE: 6 });

    const first = await request(app).put(`${API}/seller/orders/${order.id}/status`)
      .set(seller.headers).send({ status: 'CANCELLED' });
    expect(first.status).toBe(200);
    expect(await lotsOf(listing.id)).toEqual({ TWICE: 10 });

    // A repeated tap. The line is already CANCELLED, so it is no longer movable
    // and the restore must not run again — 14 units on a lot of 10 is stock the
    // Kendra does not have, and FEFO would go on allocating it.
    const repeat = await request(app).put(`${API}/seller/orders/${order.id}/status`)
      .set(seller.headers).send({ status: 'CANCELLED' });
    expect(repeat.status).toBe(200);

    expect(await lotsOf(listing.id)).toEqual({ TWICE: 10 });
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(20);
  });

  test('a buyer cancel after a seller cancel is refused and the lot stays put', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'HERBICIDE',
      lots: [{ batchNumber: 'ONCE', quantity: 10, expiresInDays: 300 }],
    });

    const order = await codOrder(farmer, listing, product, 4);
    await request(app).put(`${API}/seller/orders/${order.id}/status`)
      .set(seller.headers).send({ status: 'CANCELLED' });
    expect(await lotsOf(listing.id)).toEqual({ ONCE: 10 });

    const buyerCancel = await request(app).put(`${API}/orders/${order.id}/cancel`)
      .set(farmer.headers).send();
    expect(buyerCancel.status).toBe(400);

    expect(await lotsOf(listing.id)).toEqual({ ONCE: 10 });
  });
});

/**
 * More than one line, and more than one buyer.
 */
describe('The ledger across lines and buyers', () => {
  test('an order over two offers draws each from its own lots', async () => {
    const a = await regulatedOffer({
      stockQty: 20,
      lots: [{ batchNumber: 'A-1', quantity: 10, expiresInDays: 300 }],
    });
    const b = await regulatedOffer({
      stockQty: 20,
      kind: 'FUNGICIDE',
      lots: [{ batchNumber: 'B-1', quantity: 10, expiresInDays: 300 }],
    });

    await prisma.cartItem.deleteMany({ where: { userId: farmer.user.id } });
    await prisma.cartItem.createMany({
      data: [
        { userId: farmer.user.id, listingId: a.listing.id, productId: a.product.id, quantity: 2, unitPriceSnapshot: 100 },
        { userId: farmer.user.id, listingId: b.listing.id, productId: b.product.id, quantity: 5, unitPriceSnapshot: 100 },
      ],
    });

    const res = await request(app).post(`${API}/orders`).set(farmer.headers)
      .send({ paymentMethod: 'cod', deliveryAddress: address });
    expect(res.status).toBe(201);

    // One statement covers both lots; neither line may spill into the other's.
    expect(await lotsOf(a.listing.id)).toEqual({ 'A-1': 8 });
    expect(await lotsOf(b.listing.id)).toEqual({ 'B-1': 5 });

    const lines = await prisma.orderItem.findMany({ where: { orderId: res.body.data.id } });
    expect(lines.find((l) => l.listingId === a.listing.id).batchNumber).toBe('A-1');
    expect(lines.find((l) => l.listingId === b.listing.id).batchNumber).toBe('B-1');
  });

  test('two buyers checking out at once never draw the same units twice', async () => {
    const { product, listing } = await regulatedOffer({
      stockQty: 20,
      kind: 'HERBICIDE',
      lots: [
        { batchNumber: 'RACE-EARLY', quantity: 5, expiresInDays: 200 },
        { batchNumber: 'RACE-LATE', quantity: 15, expiresInDays: 500 },
      ],
    });

    const one = await createTestUser({ district: 'Pune', state: 'Maharashtra' });
    const two = await createTestUser({ district: 'Pune', state: 'Maharashtra' });
    await fillCart(one, listing, product, 4);
    await fillCart(two, listing, product, 4);

    const place = (buyer) => request(app).post(`${API}/orders`).set(buyer.headers)
      .send({ paymentMethod: 'cod', deliveryAddress: address });
    const results = await Promise.all([place(one), place(two)]);

    // Whichever of the two got through — the Serializable retry means both
    // normally do — the lots must have given up exactly 4 units per order and no
    // lot may be negative. Reading the stale quantity would show 5 on RACE-EARLY
    // to both and draw 8 units off a lot of 5.
    const placed = results.filter((r) => r.status === 201).length;
    expect(placed).toBeGreaterThanOrEqual(1);

    const lots = await lotsOf(listing.id);
    expect(Object.values(lots).every((q) => q >= 0)).toBe(true);
    expect(await lotTotal(listing.id)).toBe(20 - 4 * placed);
    expect((await prisma.sellerListing.findUnique({ where: { id: listing.id } })).stockQty).toBe(20 - 4 * placed);
  });
});
