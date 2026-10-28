/**
 * OrdersScreen — incoming orders and their fulfilment status.
 *
 * Endpoints: GET /agristore/seller/orders, PUT /agristore/seller/orders/:id/status.
 *
 * THE DELIVERY RUN (docs/SELLER_DELIVERY_DESIGN.md, phases 3 and 4)
 * ----------------------------------------------------------------
 * The seller delivers with their own vehicle, so this screen is also what they
 * hold at the farmer's gate:
 *
 *   - SHIPPED reads "Out for delivery" (theme ORDER_STATUS) — nothing here is
 *     ever shipped with a courier. The stored status is unchanged.
 *   - An order still to be delivered carries Call and Map. The address has no
 *     coordinates, so Map searches for it as text (utils/orderContact.js). Both
 *     stay enabled offline: a phone call needs no data, and the field is exactly
 *     where the data runs out.
 *   - Marking DELIVERED asks for the farmer's 4-digit code when one exists, and
 *     an order that went out but came back is ended with "Could not deliver"
 *     and a reason. Both are asked in OrderActionSheet; what is asked, what is
 *     sent and what a refusal means are decided in utils/orderDelivery.js.
 *   - Those two moves are NOT optimistic. A wrong code is an ordinary outcome,
 *     so the card changes only once the server has accepted, and a refusal can
 *     never leave it showing a status the order does not have.
 *
 * AN OLDER BACKEND sends no `order.delivery`. Without it this screen is exactly
 * what it was: one confirm marks delivered, and a shipped order offers no way
 * out — that server would refuse it.
 *
 * THE MONEY
 * ---------
 * The card printed the payment METHOD in capitals — "COD", "UPI" — which says
 * neither whether an online order was actually paid nor how much to take for a
 * cash one. The only figure on the card is one LINE's total, which is not what
 * is owed: it leaves out the delivery charge and the seller's other lines on the
 * same order. Each card now carries one plain statement — "Collect ₹609.00 in
 * cash", "Paid online. Do not collect cash.", "The buyer is being refunded" —
 * and the same statement is repeated at the moment of hand-over, in the
 * "mark delivered" step, which is when it matters. The amount is the server's
 * (`order.payment`); the words are decided in utils/orderPayment.js. Nothing
 * here records that cash was collected.
 *
 * THE CARD IS A JOURNEY, NOT A BADGE
 * ----------------------------------
 * The old card told you an order's state with a single coloured pill, which
 * answers "what is it" but not "how far along is it" — the question a seller
 * actually has when they open this screen. Every card now carries the four-step
 * lifecycle as a segmented rail (Pending → Confirmed → Shipped → Delivered)
 * with the reached segments filled and the current one raised, plus a written
 * "step 2 of 4". A seller can read a whole screen of orders and see which ones
 * are stuck without reading a single label.
 *
 * The advance action is a filled primary button rather than the old outlined
 * one: it is the single thing this screen exists to let you do, and there is
 * exactly one of it per card. Cancel sits below it as a soft-danger button, so
 * the destructive option is reachable but never the one your thumb lands on.
 *
 * Terminal states (cancelled, refunded) render no rail at all — an empty
 * four-step track under a cancelled order would imply it is still going.
 *
 * BEHAVIOUR — unchanged and still guaranteed:
 *   - Errors are shown. The old `catch { console.warn }` meant a 500 or a lost
 *     connection rendered as "No orders found", which for a seller reads as
 *     "nobody bought anything" rather than "the app is broken".
 *   - Status labels are translated; the chips and badges printed the raw enum.
 *   - Advancing a status is optimistic with rollback, and confirmed through a
 *     dialog that actually renders on web.
 *   - Filtering is server-side via `?status=` ONLY. The old second, client-side
 *     pass silently hid rows between changing a filter and the response.
 *   - `hasMore` was `list.length === 20`, so a shop with exactly 20 orders
 *     paged forever against an empty page 2.
 *   - The list is read again when the app comes back to the foreground. A "New
 *     order" push tapped while this screen was already on top navigates nowhere
 *     and changes no focus, so it opened a list that did not have the order.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, AppState, FlatList, Linking, Platform, RefreshControl, StyleSheet, Text, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api, { safeErrorMessage } from '@krushisarva/shared/services/api';
import DashboardStatIcon from '@krushisarva/shared/components/DashboardStatIcons';

import {
  C, R, SP, T, formatCurrency, orderStatusLabel, orderStatusMeta, useResponsive,
} from '../theme';
import usePagedList from '../hooks/usePagedList';
import { useEntrance } from '../hooks/useMotion';
import { useNetwork } from '../hooks/useNetwork';
import {
  STATUS_FLOW, moveSellerLines, nextStatusFor, orderItemQty, orderShortId,
  sellerStatusByOrder, sellerStatusOf,
} from '../utils/sellerOrders';
import {
  afterMoveSucceeded, buildStatusPayload, cancelAction, deliveryInfo, deliveryRefusal,
  isStaleStatusRefusal, patchDelivery, refusalText, statusPrompt,
} from '../utils/orderDelivery';
import { deliveryPhone, mapQuery, mapUrls, telUrl } from '../utils/orderContact';
import { handoverReminder, paymentNotice, paymentText } from '../utils/orderPayment';
import { openExternalUrl } from '../utils/openUrl';
import { refusalMessage } from '../utils/apiError';
import OrderActionSheet from '../components/OrderActionSheet';
import {
  Screen, Card, Button, Chip, FilterBar, StatusPill, StatusSteps, MetricRow,
  EmptyState, ErrorState, ListFooter, SkeletonList, InlineNotice,
  useConfirm, useToast,
} from '../components/ui';

const FILTERS = ['All', 'PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

// How each kind of payment statement is coloured. Never the only signal: each
// also has its own icon and its own words (utils/orderPayment.js).
//   collect  cash to take          amber — the one that asks the seller to act
//   paid     nothing to take       green
//   refund   money going back      blue
//   warn     an online order that was never paid — an anomaly, so red
//   quiet    history: delivered, or cancelled with nothing owed
const PAY_TONE = {
  collect: { ink: C.warning, fill: C.warningPale, line: C.warningPale },
  paid:    { ink: C.success, fill: C.successPale, line: C.successPale },
  refund:  { ink: C.info, fill: C.infoPale, line: C.infoPale },
  warn:    { ink: C.danger, fill: C.dangerPale, line: C.dangerPale },
  quiet:   { ink: C.textBody, fill: C.neutralPale, line: C.border },
};
const PAGE_SIZE = 20;

// Printed like the buyer line's "+91 …". Checkout accepts any shape whose last
// ten digits are a mobile number ("+91 98…", "098…"), so show those ten rather
// than whatever was typed.
function formatPhone(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 10 ? `+91 ${digits.slice(-10)}` : s;
}

/**
 * The delivery label a seller packs against, as two lines: who receives it
 * (name + the DELIVERY phone) and where (house → PIN).
 *
 * This used to read `address.addressLine`, a field checkout never writes — an
 * order stores flat / street / landmark (resolveDeliveryAddress in
 * agristore.routes.js) — so the seller saw only "name, city, PIN" and had to
 * phone the buyer to ask which house. `addressLine` is still read for any old
 * order that carries it instead.
 *
 * The phone is the one typed at checkout, not the account phone on the buyer
 * line: a farmer ordering for a relative's farm gives the relative's number.
 */
function deliveryAddressLines(address, t) {
  if (!address || typeof address !== 'object') return null;
  const str = (v) => (v == null ? '' : String(v).trim());
  const flat = str(address.flat);
  const street = str(address.street);
  const landmark = str(address.landmark);

  const contact = [str(address.name), formatPhone(address.phone)].filter(Boolean).join(' · ');
  const place = [
    flat,
    street,
    flat || street ? '' : str(address.addressLine),
    landmark ? `${t('checkout.landmark', 'Landmark')}: ${landmark}` : '',
    str(address.city),
    str(address.state),
    str(address.pincode),
  ].filter(Boolean).join(', ');

  return contact || place ? { contact, place } : null;
}

// ── Order card ───────────────────────────────────────────────────────────────

const OrderCard = React.memo(function OrderCard({
  item, status, index, onUpdateStatus, onCall, onMap, busy, disabled,
}) {
  const { t } = useLanguage();
  const entrance = useEntrance({ index, distance: 16 });

  // `status` is THIS seller's status on the order (sellerStatusOf), not
  // order.status — the rollup over every seller's lines. Badge, rail and both
  // buttons read it, and the way out (cancel before the goods leave, "could not
  // deliver" after) is offered exactly where the server allows it.
  const meta = orderStatusMeta(status);
  const next = nextStatusFor(status);
  const wayOut = cancelAction(status, deliveryInfo(item));
  const inFlow = meta.step >= 0;

  const address = item.order?.deliveryAddress;
  const delivery = deliveryAddressLines(address, t);

  const buyerName = item.order?.user?.name?.trim() || t('orders.buyerFallback', 'Farmer');
  const buyerPhone = item.order?.user?.phone;

  // Call and Map belong to an order still to be delivered. On a finished one
  // the number and address stay as text, but a one-tap call to last month's
  // customer is a misdial waiting to happen.
  const callNumber = next ? deliveryPhone(item.order) : null;
  const canMap = !!next && !!mapQuery(address);
  const recipient = (address && typeof address === 'object' && String(address.name ?? '').trim()) || buyerName;

  // What to say about the money, for THIS seller's part of the order and the
  // status this card is showing — see utils/orderPayment.js.
  const pay = paymentNotice(item, status);
  const paySaid = paymentText(pay, t, formatCurrency);
  const payTone = PAY_TONE[pay?.tone] || PAY_TONE.quiet;

  const createdAt = item.order?.createdAt ? new Date(item.order.createdAt) : null;
  const dateLabel = createdAt && !Number.isNaN(createdAt.getTime())
    ? createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
  // The number the farmer sees on their own order, so the two of them can name
  // the same order on a call.
  const orderNo = orderShortId(item.order);

  return (
    <Animated.View style={entrance}>
      <Card style={o.card} accent={meta.color}>
        {/* Date and order number lead the card as an eyebrow. The date used to
            be a stray line of grey text under the buttons, where nobody looks;
            the number was not shown at all. Two items in a wrapping row, with
            no dot between them: beside a long status pill the number drops to
            its own line whole, and nothing is left dangling at the end of the
            first. Read out as one thing, the number letter by letter. */}
        <View style={o.head}>
          <View
            style={o.headMeta}
            accessible
            accessibilityRole="text"
            accessibilityLabel={orderNo
              ? `${dateLabel}, ${t('orderConfirmed.orderId', 'Order ID')} ${orderNo.slice(1).split('').join(' ')}`
              : dateLabel}
          >
            <Text style={o.date} numberOfLines={1}>{dateLabel}</Text>
            {orderNo ? <Text style={o.date} numberOfLines={1}>{orderNo}</Text> : null}
          </View>
          <StatusPill status={status} t={t} size="sm" />
        </View>

        <Text style={o.product} numberOfLines={2}>
          {item.product?.name || t('common.untitled', 'Untitled product')}
        </Text>
        <Text style={o.buyer} numberOfLines={1}>
          {[buyerName, buyerPhone ? `+91 ${buyerPhone}` : null].filter(Boolean).join(' · ')}
        </Text>

        {inFlow ? (
          <View style={o.flow}>
            <StatusSteps status={status} t={t} />
            <Text style={o.flowTxt} numberOfLines={1}>
              {t('orders.stepProgress', {
                n: meta.step + 1,
                total: STATUS_FLOW.length,
                defaultValue: 'Step {{n}} of {{total}}',
              })}
              {' · '}
              {orderStatusLabel(status, t)}
            </Text>
          </View>
        ) : null}

        <MetricRow
          items={[
            {
              label: t('orders.qty', 'Qty'),
              value: orderItemQty(item),
            },
            {
              label: t('orders.amount', 'Amount'),
              value: formatCurrency(item.totalPrice),
              color: C.accentInk,
            },
          ]}
          style={{ marginTop: SP.lg }}
        />

        {/* The money, in words. One accessible element: a screen reader says
            the instruction and its explanation as one thing. An icon as well as
            a colour, so "collect" and "paid" are not told apart by hue alone. */}
        {paySaid ? (
          <View
            style={[o.pay, { backgroundColor: payTone.fill, borderColor: payTone.line }]}
            accessible
            accessibilityRole="text"
            accessibilityLabel={[paySaid.title, paySaid.hint, paySaid.detail].filter(Boolean).join('. ')}
          >
            <Ionicons name={pay.icon} size={20} color={payTone.ink} style={o.payIcon} />
            <View style={o.payBody}>
              <Text style={[o.payTitle, { color: payTone.ink }]}>{paySaid.title}</Text>
              {paySaid.hint ? <Text style={o.payHint}>{paySaid.hint}</Text> : null}
              {/* What the amount is made of. The "Amount" above is one line's
                  goods; this is why the figure here is not the same. */}
              {paySaid.detail ? <Text style={o.payDetail}>{paySaid.detail}</Text> : null}
            </View>
          </View>
        ) : null}

        {delivery ? (
          <View style={o.addrRow}>
            <Ionicons name="location-outline" size={15} color={C.textMuted} style={{ marginTop: 2 }} />
            {/* No numberOfLines: flat + street + landmark run to several lines,
                and a clipped address is one the seller cannot deliver to.
                Selectable so it can be pasted into a courier booking. */}
            <View style={o.addrBody}>
              {delivery.contact ? <Text style={o.addrTxt} selectable>{delivery.contact}</Text> : null}
              {delivery.place ? <Text style={o.addrTxt} selectable>{delivery.place}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* Not tied to `disabled` (offline): a call needs no data connection,
            and a map app may hold the area offline. Each is drawn only when
            there is a number to dial or an address to search. */}
        {callNumber || canMap ? (
          <View style={o.contactRow}>
            {callNumber ? (
              <Button
                label={t('sellerOrders.call', 'Call')}
                icon="call-outline"
                variant="secondary"
                size="md"
                onPress={() => onCall(item)}
                accessibilityLabel={t('sellerOrders.callA11y', { name: recipient, defaultValue: 'Call {{name}}' })}
                style={o.contactBtn}
              />
            ) : null}
            {canMap ? (
              <Button
                label={t('sellerOrders.map', 'Map')}
                icon="navigate-outline"
                variant="secondary"
                size="md"
                onPress={() => onMap(item)}
                accessibilityLabel={t('sellerOrders.mapA11y', 'Show the delivery address on a map')}
                accessibilityHint={t('sellerOrders.mapHint', 'Opens your map app')}
                style={o.contactBtn}
              />
            ) : null}
          </View>
        ) : null}

        {next ? (
          <Button
            label={t('orders.markAs', { status: orderStatusLabel(next, t) })}
            iconRight="arrow-forward"
            size="md"
            fullWidth
            loading={busy}
            disabled={disabled}
            onPress={() => onUpdateStatus(item, next, status)}
            style={{ marginTop: SP.xl }}
          />
        ) : null}

        {wayOut === 'cancel' ? (
          <Button
            label={t('orders.cancelOrder', 'Cancel order')}
            icon="close-circle-outline"
            variant="dangerSoft"
            size="md"
            fullWidth
            haptic="warning"
            disabled={disabled || busy}
            onPress={() => onUpdateStatus(item, 'CANCELLED', status)}
            style={{ marginTop: SP.sm }}
          />
        ) : null}

        {/* The goods are out, so this is not a plain cancel: it asks why, and
            says the stock comes back and an online payment is refunded. */}
        {wayOut === 'undelivered' ? (
          <Button
            label={t('sellerOrders.couldNotDeliver', 'Could not deliver')}
            icon="alert-circle-outline"
            variant="dangerSoft"
            size="md"
            fullWidth
            haptic="warning"
            disabled={disabled || busy}
            onPress={() => onUpdateStatus(item, 'CANCELLED', status)}
            accessibilityHint={t('sellerOrders.couldNotDeliverHint', 'Asks for the reason, then cancels the order')}
            style={{ marginTop: SP.sm }}
          />
        ) : null}
      </Card>
    </Animated.View>
  );
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function OrdersScreen({ navigation }) {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const toast = useToast();
  const { isOffline } = useNetwork();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();

  const [filter, setFilter] = useState('All');
  const [busyIds, setBusyIds] = useState(() => new Set());
  // The open OrderActionSheet's request, or null. `key` is unique per opening.
  const [sheet, setSheet] = useState(null);
  const sheetSeq = useRef(0);

  const markBusy = useCallback((id, on) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const list = usePagedList({
    mode: 'page',
    limit: PAGE_SIZE,
    deps: [filter],
    refetchOnFocus: true,
    errorFallback: t('orders.loadError', 'Could not load your orders.'),
    fetchPage: useCallback(({ page, limit, signal }) => {
      const statusQ = filter !== 'All' ? `&status=${encodeURIComponent(filter)}` : '';
      return api.get(`/agristore/seller/orders?page=${page}&limit=${limit}${statusQ}`, { signal });
    }, [filter]),
  });

  const { items, setItems, refresh } = list;

  // What a move the server ACCEPTED leaves on the list. `sent` is what went
  // with the request (a `failedReason` is what lets shipped lines be cancelled).
  const settleMove = useCallback((orderId, newStatus, sent) => {
    setItems((prev) => {
      // Applied here even after an optimistic update: a list refresh that was
      // already in flight can land in between and put the old statuses back.
      // Moving again is harmless — a line already there cannot make the move.
      const moved = moveSellerLines(prev, orderId, newStatus, sent);
      // Going out for delivery created the farmer's code; the card must ask
      // for it on the next tap without waiting for a refresh.
      const rows = afterMoveSucceeded(moved, orderId, newStatus);
      // The row no longer matches the active filter — drop it so the list stays
      // truthful rather than showing a DELIVERED order under "Pending".
      return filter !== 'All' && filter !== newStatus
        ? rows.filter((row) => row.order?.id !== orderId || row.status === filter)
        : rows;
    });
  }, [filter, setItems]);

  const handleUpdateStatus = useCallback(async (item, newStatus, fromStatus) => {
    const orderId = item.order?.id;
    if (!orderId) {
      toast.error(t('orders.updateStatusError', 'Could not update this order.'));
      return;
    }

    // A delivery code, or a reason, is asked for in the sheet — and that move
    // is sent from there (handleSheetSubmit), not from this function.
    const info = deliveryInfo(item);
    const prompt = statusPrompt(fromStatus, newStatus, info);
    if (prompt !== 'confirm') {
      sheetSeq.current += 1;
      setSheet({
        key: sheetSeq.current,
        orderId,
        to: newStatus,
        step: prompt,
        hasCode: !!info?.hasCode,
        lockedUntil: info?.lockedUntil ?? null,
        // Said again at the door, where the money actually changes hands.
        payment: newStatus === 'DELIVERED' ? handoverReminder(item, fromStatus, t, formatCurrency) : null,
      });
      return;
    }

    const label = orderStatusLabel(newStatus, t);
    const destructive = newStatus === 'CANCELLED';
    // On a backend that issues delivery codes, this is the tap that creates
    // one. Saying so is what makes the seller ask for it at the door.
    const startsDelivery = newStatus === 'SHIPPED' && !!info;
    // One-tap delivery (no code to ask for): the confirmation is the last thing
    // read before the goods are handed over, so the money is said there.
    const reminder = newStatus === 'DELIVERED' ? handoverReminder(item, fromStatus, t, formatCurrency) : null;

    const ok = await confirm({
      title: destructive
        ? t('orders.cancelOrder', 'Cancel order')
        : t('orders.markAs', { status: label }),
      message: destructive
        ? t('orders.cancelMsg', { defaultValue: 'The buyer will be notified that this order is cancelled. This cannot be undone.' })
        : startsDelivery
          ? t('sellerOrders.outForDeliveryMsg', 'The farmer will get a 4-digit delivery code. Ask for it when you hand over the order.')
          : [reminder?.text, t('orders.markAsMsg', { status: label })].filter(Boolean).join('\n\n'),
      confirmLabel: destructive ? t('orders.cancelOrder', 'Cancel order') : t('orders.confirm', 'Confirm'),
      cancelLabel: t('cancel', 'Cancel'),
      destructive,
      icon: destructive ? 'close-circle-outline' : 'arrow-forward-circle-outline',
    });
    if (!ok) return;

    markBusy(orderId, true);

    // The server moves every one of this seller's lines on the order that may
    // make the move, and leaves the rest (a cancelled line stays cancelled).
    // Mirror that on the LINE statuses — order.status is the all-seller rollup
    // and is not what the cards read — and keep each line's old status so a
    // failure puts back exactly what was there.
    const previous = new Map();
    setItems((prev) => {
      prev.forEach((row) => { if (row.order?.id === orderId) previous.set(row.id, row.status); });
      return moveSellerLines(prev, orderId, newStatus);
    });

    try {
      await api.put(`/agristore/seller/orders/${orderId}/status`, buildStatusPayload(newStatus));
      toast.success(t('orders.statusUpdated', { status: label, defaultValue: `Order marked ${label}` }));
      settleMove(orderId, newStatus);
    } catch (e) {
      setItems((prev) => prev.map((row) => (
        previous.has(row.id) && row.status !== previous.get(row.id)
          ? { ...row, status: previous.get(row.id) }
          : row
      )));
      // A refused move (409) says why — "already shipped and cannot be marked
      // cancelled" — rather than the generic "a conflict occurred".
      const refusal = deliveryRefusal(e);
      toast.error(refusalText(refusal, t) || refusalMessage(e)
        || safeErrorMessage(e, t('orders.updateStatusError', 'Could not update this order.')));
      // Either way the server holds something this list does not: the order
      // moved on another phone, or a code became required after the list was
      // read. Read it again, so the card shows its real status and the next tap
      // asks the right question.
      if (refusal || isStaleStatusRefusal(e)) refresh();
    } finally {
      markBusy(orderId, false);
    }
  }, [confirm, markBusy, refresh, setItems, settleMove, toast, t]);

  // The sheet's "send". NOT optimistic: the card moves only when the server
  // says yes, so a wrong code leaves it exactly as it was — out for delivery.
  // Resolves to what the sheet needs to show; the sheet is closed from here.
  const handleSheetSubmit = useCallback(async (request, sent) => {
    const { orderId, to } = request;
    markBusy(orderId, true);
    try {
      await api.put(`/agristore/seller/orders/${orderId}/status`, buildStatusPayload(to, sent));
    } catch (e) {
      const refusal = deliveryRefusal(e);
      // Kept on the rows too, so the lock is still shown if the sheet is closed
      // and opened again before it ends.
      if (refusal?.lockedUntil) {
        setItems((prev) => patchDelivery(prev, orderId, { lockedUntil: refusal.lockedUntil }));
      }
      if (isStaleStatusRefusal(e)) refresh();
      return {
        ok: false,
        refusal,
        message: refusalText(refusal, t) || refusalMessage(e)
          || safeErrorMessage(e, t('orders.updateStatusError', 'Could not update this order.')),
      };
    } finally {
      markBusy(orderId, false);
    }

    settleMove(orderId, to, sent);
    setSheet(null);
    toast.success(to === 'CANCELLED'
      ? t('sellerOrders.undeliveredDone', 'Marked as not delivered. The stock is back in your shop.')
      : t('orders.statusUpdated', {
          status: orderStatusLabel(to, t),
          defaultValue: `Order marked ${orderStatusLabel(to, t)}`,
        }));
    return { ok: true };
  }, [markBusy, refresh, setItems, settleMove, toast, t]);

  const closeSheet = useCallback(() => setSheet(null), []);

  // tel: and geo: skip canOpenURL — on Android 11+ it answers false for both on
  // a phone that can obviously dial. See utils/openUrl.js.
  const handleCall = useCallback(async (item) => {
    const url = telUrl(deliveryPhone(item.order));
    if (!url || !(await openExternalUrl(url, Linking))) {
      toast.error(t('share.callFailed', 'This device cannot place calls.'));
    }
  }, [toast, t]);

  // The phone's own map app first, then the web map, so a phone with no map
  // app installed still shows the place in a browser.
  const handleMap = useCallback(async (item) => {
    for (const url of mapUrls(item.order?.deliveryAddress, Platform.OS)) {
      // eslint-disable-next-line no-await-in-loop
      if (await openExternalUrl(url, Linking)) return;
    }
    toast.error(t('sellerOrders.mapFailed', 'Could not open a map on this device.'));
  }, [toast, t]);

  // Back in the foreground → read the list again. Focus refetch does not cover
  // it: a "New order" push tapped with this screen already on top changes no
  // focus, and neither does reopening the app from its icon. Skipped while a
  // status change is in flight or being typed, so a refresh cannot land on top
  // of it. Read through a ref so the listener is registered once.
  const live = useRef(null);
  live.current = {
    refresh,
    ready: list.hasLoaded && busyIds.size === 0 && !sheet,
  };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !live.current.ready) return;
      if (navigation?.isFocused && !navigation.isFocused()) return;
      live.current.refresh();
    });
    return () => sub.remove();
  }, [navigation]);

  // This seller's status per order, from their own lines on screen.
  const statusByOrder = useMemo(() => sellerStatusByOrder(items), [items]);

  const renderItem = useCallback(({ item, index }) => (
    <OrderCard
      item={item}
      status={sellerStatusOf(item, statusByOrder)}
      index={index}
      onUpdateStatus={handleUpdateStatus}
      onCall={handleCall}
      onMap={handleMap}
      busy={busyIds.has(item.order?.id)}
      disabled={isOffline}
    />
  ), [handleUpdateStatus, handleCall, handleMap, busyIds, isOffline, statusByOrder]);

  const keyExtractor = useCallback(
    (item, index) => (item?.id != null ? String(item.id) : `order-${index}`),
    [],
  );

  const emptyBody = useMemo(() => (
    filter === 'All'
      ? t('orders.noOrdersAll', 'Orders from farmers will show up here.')
      : t('orders.noOrdersFilter', { status: orderStatusLabel(filter, t) })
  ), [filter, t]);

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <FilterBar>
        {FILTERS.map((key) => (
          <Chip
            key={key}
            label={key === 'All' ? t('orders.filterAll', 'All') : orderStatusLabel(key, t)}
            selected={filter === key}
            onPress={() => setFilter(key)}
            size="sm"
          />
        ))}
      </FilterBar>

      {list.isInitialLoading ? (
        <SkeletonList count={4} thumb={false} />
      ) : list.error && items.length === 0 ? (
        <ErrorState error={list.error} onRetry={list.retry} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={[
            { padding: gutter, paddingBottom: SP.huge, flexGrow: 1 },
            isExpanded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={list.refresh}
              tintColor={C.brand}
              colors={[C.brand]}
            />
          }
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.4}
          ListHeaderComponent={
            list.error && items.length > 0 ? (
              <InlineNotice variant="warning" style={{ marginBottom: SP.lg }}>
                {t('common.staleData', 'Showing saved data — refresh failed.')}
              </InlineNotice>
            ) : null
          }
          ListFooterComponent={
            <ListFooter
              loading={list.loadingMore}
              error={list.moreError}
              onRetry={list.retryMore}
              hasMore={list.hasMore}
              itemCount={items.length}
            />
          }
          ListEmptyComponent={
            <EmptyState
              illustration={<DashboardStatIcon type="orders" size={60} animated={false} />}
              title={t('orders.noOrdersFound', 'No orders found')}
              body={emptyBody}
              actionLabel={filter !== 'All' ? t('orders.clearFilter', 'Show all orders') : undefined}
              onAction={filter !== 'All' ? () => setFilter('All') : undefined}
            />
          }
          initialNumToRender={5}
          maxToRenderPerBatch={7}
          windowSize={9}
          removeClippedSubviews={false}
        />
      )}

      {/* One sheet for the whole list, not one per card. */}
      <OrderActionSheet
        request={sheet}
        busy={!!sheet && busyIds.has(sheet.orderId)}
        offline={isOffline}
        onClose={closeSheet}
        onSubmit={handleSheetSubmit}
      />
    </Screen>
  );
}

const o = StyleSheet.create({
  card: { marginBottom: SP.lg },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SP.md,
    marginBottom: SP.md,
  },
  // Shrinks before the status pill does; its two items wrap as whole words.
  headMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SP.md, rowGap: 2, flexShrink: 1, minWidth: 0 },
  date: { ...T.micro, color: C.textFaint, textTransform: 'uppercase', flexShrink: 1 },

  product: { ...T.subhead, color: C.text },
  buyer: { ...T.caption, color: C.textMuted, marginTop: SP.xs },

  // The payment statement. A filled strip rather than another metric: it is an
  // instruction ("collect", "do not collect"), and the three figures above it
  // are facts about the line.
  pay: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SP.md,
    marginTop: SP.lg,
    paddingVertical: SP.md,
    paddingHorizontal: SP.lg,
    borderRadius: R.lg,
    borderWidth: 1,
  },
  payIcon: { marginTop: 1 },
  payBody: { flex: 1, minWidth: 0, gap: SP.xxs },
  payTitle: { ...T.bodyBold },
  payHint: { ...T.caption, color: C.textBody },
  // Figures, so the bolder caption: "Items ₹540 + delivery ₹69".
  payDetail: { ...T.captionBold, color: C.textBody, marginTop: SP.xxs },

  flow: { marginTop: SP.lg, gap: SP.sm },
  flowTxt: { ...T.micro, color: C.textMuted, textTransform: 'uppercase' },

  addrRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SP.sm, marginTop: SP.lg },
  // flex lives on the column, not the Text: a flex:1 Text inside an auto-height
  // column gets a zero basis and can collapse.
  addrBody: { flex: 1, gap: 2 },
  addrTxt: { ...T.caption, color: C.textMuted, lineHeight: 18 },

  // Two equal halves; one button alone takes the full row. minWidth 0 lets a
  // long translated label shrink inside its half instead of widening the card.
  contactRow: { flexDirection: 'row', gap: SP.sm, marginTop: SP.lg },
  contactBtn: { flex: 1, minWidth: 0 },
});
