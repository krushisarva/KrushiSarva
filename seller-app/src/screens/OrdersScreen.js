/**
 * OrdersScreen — incoming orders and their fulfilment status.
 *
 * Endpoints, status flow and payloads are unchanged.
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
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Animated, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api, { safeErrorMessage } from '@krushisarva/shared/services/api';
import DashboardStatIcon from '@krushisarva/shared/components/DashboardStatIcons';

import {
  C, SP, T, formatCurrency, orderStatusLabel, orderStatusMeta, useResponsive,
} from '../theme';
import usePagedList from '../hooks/usePagedList';
import { useEntrance } from '../hooks/useMotion';
import { useNetwork } from '../hooks/useNetwork';
import {
  STATUS_FLOW, canSellerCancel, moveSellerLines, nextStatusFor, orderItemQty,
  sellerStatusByOrder, sellerStatusOf,
} from '../utils/sellerOrders';
import { refusalMessage } from '../utils/apiError';
import {
  Screen, Card, Button, Chip, FilterBar, StatusPill, StatusSteps, MetricRow,
  EmptyState, ErrorState, ListFooter, SkeletonList, InlineNotice,
  useConfirm, useToast,
} from '../components/ui';

const FILTERS = ['All', 'PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
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

const OrderCard = React.memo(function OrderCard({ item, status, index, onUpdateStatus, busy, disabled }) {
  const { t } = useLanguage();
  const entrance = useEntrance({ index, distance: 16 });

  // `status` is THIS seller's status on the order (sellerStatusOf), not
  // order.status — the rollup over every seller's lines. Badge, rail and both
  // buttons read it, and cancel is offered exactly where the server allows it.
  const meta = orderStatusMeta(status);
  const next = nextStatusFor(status);
  const canCancel = canSellerCancel(status);
  const inFlow = meta.step >= 0;

  const delivery = deliveryAddressLines(item.order?.deliveryAddress, t);

  const buyerName = item.order?.user?.name?.trim() || t('orders.buyerFallback', 'Farmer');
  const buyerPhone = item.order?.user?.phone;

  const createdAt = item.order?.createdAt ? new Date(item.order.createdAt) : null;
  const dateLabel = createdAt && !Number.isNaN(createdAt.getTime())
    ? createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

  return (
    <Animated.View style={entrance}>
      <Card style={o.card} accent={meta.color}>
        {/* Date leads the card as an eyebrow. It used to be a stray line of
            grey text under the buttons, which is where nobody looks. */}
        <View style={o.head}>
          <Text style={o.date} numberOfLines={1}>{dateLabel}</Text>
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
            {
              label: t('orders.payment', 'Payment'),
              value: item.order?.paymentMethod?.toUpperCase() || '—',
            },
          ]}
          style={{ marginTop: SP.lg }}
        />

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

        {next ? (
          <Button
            label={t('orders.markAs', { status: orderStatusLabel(next, t) })}
            iconRight="arrow-forward"
            size="md"
            fullWidth
            loading={busy}
            disabled={disabled}
            onPress={() => onUpdateStatus(item, next)}
            style={{ marginTop: SP.xl }}
          />
        ) : null}

        {canCancel ? (
          <Button
            label={t('orders.cancelOrder', 'Cancel order')}
            icon="close-circle-outline"
            variant="dangerSoft"
            size="md"
            fullWidth
            haptic="warning"
            disabled={disabled || busy}
            onPress={() => onUpdateStatus(item, 'CANCELLED')}
            style={{ marginTop: SP.sm }}
          />
        ) : null}
      </Card>
    </Animated.View>
  );
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function OrdersScreen() {
  const { t } = useLanguage();
  const confirm = useConfirm();
  const toast = useToast();
  const { isOffline } = useNetwork();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();

  const [filter, setFilter] = useState('All');
  const [busyIds, setBusyIds] = useState(() => new Set());

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

  const { items, setItems } = list;

  const handleUpdateStatus = useCallback(async (item, newStatus) => {
    const orderId = item.order?.id;
    if (!orderId) {
      toast.error(t('orders.updateStatusError', 'Could not update this order.'));
      return;
    }

    const label = orderStatusLabel(newStatus, t);
    const destructive = newStatus === 'CANCELLED';

    const ok = await confirm({
      title: destructive
        ? t('orders.cancelOrder', 'Cancel order')
        : t('orders.markAs', { status: label }),
      message: destructive
        ? t('orders.cancelMsg', { defaultValue: 'The buyer will be notified that this order is cancelled. This cannot be undone.' })
        : t('orders.markAsMsg', { status: label }),
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
      await api.put(`/agristore/seller/orders/${orderId}/status`, { status: newStatus });
      toast.success(t('orders.statusUpdated', { status: label, defaultValue: `Order marked ${label}` }));

      // The row no longer matches the active filter — drop it so the list stays
      // truthful rather than showing a DELIVERED order under "Pending".
      if (filter !== 'All' && filter !== newStatus) {
        setItems((prev) => prev.filter((row) => row.order?.id !== orderId || row.status === filter));
      }
    } catch (e) {
      setItems((prev) => prev.map((row) => (
        previous.has(row.id) && row.status !== previous.get(row.id)
          ? { ...row, status: previous.get(row.id) }
          : row
      )));
      // A refused move (409) says why — "already shipped and cannot be marked
      // cancelled" — rather than the generic "a conflict occurred".
      toast.error(refusalMessage(e)
        || safeErrorMessage(e, t('orders.updateStatusError', 'Could not update this order.')));
    } finally {
      markBusy(orderId, false);
    }
  }, [confirm, filter, markBusy, setItems, toast, t]);

  // This seller's status per order, from their own lines on screen.
  const statusByOrder = useMemo(() => sellerStatusByOrder(items), [items]);

  const renderItem = useCallback(({ item, index }) => (
    <OrderCard
      item={item}
      status={sellerStatusOf(item, statusByOrder)}
      index={index}
      onUpdateStatus={handleUpdateStatus}
      busy={busyIds.has(item.order?.id)}
      disabled={isOffline}
    />
  ), [handleUpdateStatus, busyIds, isOffline, statusByOrder]);

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
  date: { ...T.micro, color: C.textFaint, textTransform: 'uppercase', flexShrink: 1 },

  product: { ...T.subhead, color: C.text },
  buyer: { ...T.caption, color: C.textMuted, marginTop: SP.xs },

  flow: { marginTop: SP.lg, gap: SP.sm },
  flowTxt: { ...T.micro, color: C.textMuted, textTransform: 'uppercase' },

  addrRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SP.sm, marginTop: SP.lg },
  // flex lives on the column, not the Text: a flex:1 Text inside an auto-height
  // column gets a zero basis and can collapse.
  addrBody: { flex: 1, gap: 2 },
  addrTxt: { ...T.caption, color: C.textMuted, lineHeight: 18 },
});
