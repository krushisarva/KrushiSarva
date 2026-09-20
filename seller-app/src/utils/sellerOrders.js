/**
 * Seller order-line display logic — no React, no React Native.
 *
 * GET /agristore/seller/orders returns one row per ORDER ITEM of this seller,
 * each with its own `status` and the parent `order`. OrdersScreen and
 * DashboardScreen used to read `order.status`, which is the rollup over EVERY
 * seller's lines: on a two-seller order where the other Kendra had shipped,
 * this seller's untouched PENDING line showed "Confirmed" and offered "Mark
 * shipped" with no cancel.
 */

export const STATUS_FLOW = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED'];

// Mirrors SELLER_ITEM_TRANSITIONS in backend agristore.routes.js (PUT
// /seller/orders/:orderId/status): forward only, cancel only before shipping.
const SELLER_ITEM_TRANSITIONS = {
  PENDING:   ['CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'DELIVERED', 'CANCELLED'],
  SHIPPED:   ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** Whether the server will move a line from `from` to `to`. */
export function canMove(from, to) {
  return !!SELLER_ITEM_TRANSITIONS[from]?.includes(to);
}

/** Next status in the fulfilment flow, or null when the line is terminal. */
export function nextStatusFor(status) {
  const i = STATUS_FLOW.indexOf(status);
  if (i === -1 || i >= STATUS_FLOW.length - 1) return null;
  return STATUS_FLOW[i + 1];
}

/** Cancel is offered exactly where the server allows it. */
export function canSellerCancel(status) {
  return canMove(status, 'CANCELLED');
}

/**
 * orderId → this seller's status on that order, from their own lines in `rows`.
 *
 * The status route moves all of the seller's movable lines together, so one
 * order has one status per seller. If the lines are mixed, the least-advanced
 * LIVE one is used: its next step is the one still owed, and advancing from a
 * further line would drag the lagging one past steps it never took. With no
 * live line left, the order is CANCELLED for this seller.
 */
export function sellerStatusByOrder(rows) {
  const byOrder = new Map();
  for (const row of rows || []) {
    const orderId = row?.order?.id;
    const status = row?.status;
    if (!orderId || !status) continue;
    const prev = byOrder.get(orderId);
    if (status === 'CANCELLED') {
      if (!prev) byOrder.set(orderId, 'CANCELLED');
      continue;
    }
    const rank = STATUS_FLOW.indexOf(status);
    if (!prev || prev === 'CANCELLED' || (rank !== -1 && rank < STATUS_FLOW.indexOf(prev))) {
      byOrder.set(orderId, status);
    }
  }
  return byOrder;
}

/**
 * The status one card shows and acts on.
 *   - REFUNDED is set on the ORDER by an admin and leaves the lines alone; the
 *     seller must not be offered "Mark shipped" on money already returned.
 *   - A cancelled line shows as cancelled even beside live ones — the card is
 *     that line's product and amount.
 *   - Otherwise the seller's status on the order (above).
 * Falls back to `order.status` only for a row without a line status.
 */
export function sellerStatusOf(row, byOrder) {
  if (row?.order?.status === 'REFUNDED') return 'REFUNDED';
  const own = row?.status;
  if (!own) return row?.order?.status ?? null;
  if (own === 'CANCELLED') return own;
  return byOrder?.get(row?.order?.id) ?? own;
}

/**
 * `rows` after the seller moves `orderId` to `to`, as the server applies it:
 * only this seller's lines that may make the move change; the rest stay.
 */
export function moveSellerLines(rows, orderId, to) {
  return rows.map((row) => (
    row?.order?.id === orderId && canMove(row.status, to) ? { ...row, status: to } : row
  ));
}

/**
 * The unit a line was sold in. The order item keeps a frozen `unit` from
 * checkout; the route also attaches the variant. `product.unit` was never
 * selected by the route, so "2 kg" printed as "2".
 */
export function orderItemUnit(item) {
  return item?.unit || item?.variant?.unit || item?.product?.unit || '';
}

/** "2 kg" — or just the number when the unit is unknown, "—" with no quantity. */
export function orderItemQty(item) {
  return `${item?.quantity ?? '—'} ${orderItemUnit(item)}`.trim();
}
