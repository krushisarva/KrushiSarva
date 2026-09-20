/**
 * My Orders — the farmer's record of what they bought and what they paid.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * This screen read `order.total`. The column is `totalAmount`, so the expression
 * evaluated to `parseFloat(undefined || 0)` and EVERY order displayed ₹0.00 —
 * on the one screen a farmer opens to check they were charged correctly.
 *
 * The status badges were equally broken: they looked up `orders.statusPending`
 * and friends, none of which exist in translations.js, so the badge rendered the
 * literal key text "orders.statusConfirmed".
 *
 * ── Where the money is ──────────────────────────────────────────────────────
 * `order.paymentStatus` is the only record of what happened to a cancelled
 * order's money, and this screen rendered none of it: a cancelled online-paid
 * order looked exactly like a cancelled cash order. It now carries the refund
 * line, an expandable detail (this app has no separate order-detail screen), and
 * the cancel action — whose confirmation names the EXACT rupee figure the server
 * will refund, worked out the same way `orderRefund.service.js` works it out,
 * rather than assuming the order total comes back.
 *
 * ── The snapshot rule ───────────────────────────────────────────────────────
 * Item name, image and price come from the ORDER ITEM's own snapshot columns
 * first, and only fall back to the live product join. An order is a record of a
 * past transaction: if the seller renames the product, re-photographs it or
 * delists it, the farmer's receipt must not change underneath them. The live
 * join is the fallback for rows written before those columns existed.
 */
import { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '@krushisarva/shared/constants/colors';
import api from '@krushisarva/shared/services/api';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import DashboardStatIcon from '@krushisarva/shared/components/DashboardStatIcons';
import { SkeletonList } from '../../components/ui/Skeleton';
// The order screens are Shop screens; the refund-status mapping, the cancel
// guard and the refund arithmetic live with the rest of the Shop logic so they
// are unit-testable without a React Native runtime.
import {
  orderRefundLabel, humanOrderStatus, canCancelOrder, cancelRefundPreview,
} from '../AgriStore/shopUtils';
import { cancelOrder } from '../AgriStore/shopClient';

/** ₹ with Indian digit grouping (1,20,000 — not 120,000). */
function inr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₹0';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Every member of the OrderStatus enum is represented. REFUNDED was missing,
// which meant a refunded order showed the raw string "REFUNDED" in grey — the
// one status where the farmer most needs a clear answer.
const STATUS_META = {
  PENDING:   { key: 'orders.statusPending',   color: COLORS.gold,      bg: COLORS.goldPale   },
  CONFIRMED: { key: 'orders.statusConfirmed', color: COLORS.blue,      bg: COLORS.bluePale   },
  SHIPPED:   { key: 'orders.statusShipped',   color: COLORS.violet,    bg: COLORS.violetPale },
  DELIVERED: { key: 'orders.statusDelivered', color: COLORS.emerald,   bg: COLORS.mintPale   },
  CANCELLED: { key: 'orders.statusCancelled', color: COLORS.error,     bg: COLORS.errorLight },
  REFUNDED:  { key: 'orders.statusRefunded',  color: COLORS.textMedium, bg: COLORS.grayBg    },
};

function StatusBadge({ status }) {
  const { t } = useLanguage();
  const meta = STATUS_META[status];
  // An unknown status — a value added to the OrderStatus enum after this APK
  // shipped — used to render the raw code, so a farmer was shown the literal
  // word "RETURN_REQUESTED". It degrades to a title-cased phrase instead: not a
  // translation, but a readable one that cannot be WRONG the way a guess can.
  // A status that is missing altogether shows nothing rather than an empty pill.
  const label = meta ? t(meta.key) : humanOrderStatus(status);
  if (!label) return null;
  return (
    <View style={[styles.badge, { backgroundColor: meta?.bg || COLORS.grayBg }]}>
      <Text style={[styles.badgeTxt, { color: meta?.color || COLORS.textMedium }]}>{label}</Text>
    </View>
  );
}

/**
 * "Refund on the way — 5–7 working days", and the rest of the refund states.
 *
 * `order.paymentStatus` is the only place the money's fate is recorded, and this
 * screen rendered none of it: a cancelled online-paid order looked exactly like
 * a cancelled cash order, with no statement anywhere that the money was coming
 * back. A paymentStatus with nothing to say about a refund ('pending', 'paid')
 * and one this build does not recognise both render nothing at all — silence
 * beats a wrong promise about money.
 */
function RefundLine({ paymentStatus }) {
  const { t } = useLanguage();
  const label = orderRefundLabel(paymentStatus);
  if (!label) return null;
  return (
    <View style={styles.refundRow}>
      <Ionicons
        name={label.done ? 'checkmark-circle' : 'time-outline'}
        size={14}
        color={label.done ? COLORS.emerald : COLORS.gold}
      />
      <Text style={[styles.refundTxt, label.done && { color: COLORS.emerald }]}>
        {t(label.key, label.fallback)}
      </Text>
    </View>
  );
}

const OrderCard = memo(function OrderCard({ order, onCancelled }) {
  const { t, language } = useLanguage();
  const [imgFailed, setImgFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const firstItem = order.items?.[0];
  // Snapshot first, live join second — see the header.
  const itemName =
    (language === 'mr' && firstItem?.productNameMr) ||
    firstItem?.productName ||
    firstItem?.product?.name ||
    t('orders.itemFallback');
  const itemImg = firstItem?.productImage || firstItem?.product?.images?.[0];

  const extraCount = Math.max((order.items?.length || 1) - 1, 0);

  // `totalAmount` is THE PAYABLE (goods + delivery + tax − discount) since the
  // Shop hardening pass. `total` is kept as a fallback only so an older cached
  // response cannot blank the figure out.
  const payable = Number(order.totalAmount ?? order.total ?? 0);
  const delivery = Number(order.deliveryFee ?? 0);
  const tax = Number(order.taxAmount ?? 0);
  const showBreakdown = delivery > 0 || tax > 0;

  const date = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

  const subtotal = Number(order.subtotal ?? 0);
  const discount = Number(order.discountAmount ?? 0);
  const items = Array.isArray(order.items) ? order.items : [];
  const isCod = order.paymentMethod === 'cod';

  // Mirrors PUT /orders/:id/cancel's own guard, so the button is never offered
  // for an order the server will refuse.
  const cancellable = canCancelOrder(order);
  // EXACTLY what cancelling returns — the order total MINUS anything a seller's
  // earlier cancel has already refunded. Never the order total by assumption.
  const preview = cancelRefundPreview(order);

  function askCancel() {
    // Covers both cash on delivery and an online order whose money was never
    // captured: in neither case is there anything to promise back.
    const body = !preview.refundable
      ? t('orders.cancelNoRefundMsg', 'No money has been taken for this order, so there is nothing to refund.')
      : preview.amount != null
        ? t('orders.cancelRefundMsg', {
          amount: inr(preview.amount),
          defaultValue: '{{amount}} will be refunded to the account you paid from. It usually arrives in 5–7 working days.',
        })
        // The list payload had no lines to work the figure out from. Say a refund
        // is coming without naming a number rather than naming a wrong one.
        : t('orders.cancelRefundUnknownMsg',
          'What you paid for this order will be refunded to the account you paid from. It usually arrives in 5–7 working days.');

    Alert.alert(
      t('orders.cancelTitle', 'Cancel this order?'),
      body,
      [
        { text: t('orders.cancelKeep', 'Keep order'), style: 'cancel' },
        { text: t('orders.cancelConfirm', 'Cancel order'), style: 'destructive', onPress: doCancel },
      ],
    );
  }

  async function doCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      const res = await cancelOrder(order.id);
      onCancelled?.(order.id, res);
      // The SERVER's figure, not the preview: this is what it actually raised.
      // It is absent whenever nothing was owed.
      const refunded = Number(res?.refundAmount);
      Alert.alert(
        t('orders.cancelledTitle', 'Order cancelled'),
        Number.isFinite(refunded) && refunded > 0
          ? t('orders.cancelledRefundMsg', {
            amount: inr(refunded),
            defaultValue: '{{amount}} is being refunded to the account you paid from — it usually arrives in 5–7 working days.',
          })
          : t('orders.cancelledNoRefundMsg', 'Your order has been cancelled.'),
      );
    } catch (err) {
      Alert.alert(
        t('orders.cancelFailedTitle', 'Could not cancel'),
        // `userMessage` is the API client's sanitised text — e.g. the server's
        // "Cannot cancel a confirmed order" when a seller got there first.
        err?.userMessage || t('orders.cancelFailedMsg', 'Could not cancel this order. Please refresh and try again.'),
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.orderId} numberOfLines={1}>#{order.id?.slice(-8)?.toUpperCase()}</Text>
        <StatusBadge status={order.status} />
      </View>

      <View style={styles.itemRow}>
        {itemImg && !imgFailed ? (
          <Image source={{ uri: itemImg }} style={styles.thumb} onError={() => setImgFailed(true)} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <Ionicons name="cube-outline" size={22} color={COLORS.textMedium} />
          </View>
        )}
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.productName} numberOfLines={2}>{itemName}</Text>
          {extraCount > 0 ? (
            <Text style={styles.moreItems}>
              {extraCount > 1
                ? t('orders.moreItemsPlural', { count: extraCount })
                : t('orders.moreItem', { count: extraCount })}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Shown only when the farmer actually paid these — a ₹0 delivery line is
          noise, and printing "Tax ₹0" invites the question of why. */}
      {showBreakdown ? (
        <View style={styles.breakdown}>
          {delivery > 0 ? (
            <View style={styles.breakRow}>
              <Text style={styles.breakLabel}>{t('orders.deliveryFee')}</Text>
              <Text style={styles.breakVal}>{inr(delivery)}</Text>
            </View>
          ) : null}
          {tax > 0 ? (
            <View style={styles.breakRow}>
              <Text style={styles.breakLabel}>{t('orders.tax')}</Text>
              <Text style={styles.breakVal}>{inr(tax)}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Where the money actually is. Rendered on the collapsed card too: a
          farmer checking whether their refund has come should not have to open
          anything to find out. */}
      <RefundLine paymentStatus={order.paymentStatus} />

      <View style={styles.cardFooter}>
        <View style={styles.footerLeft}>
          <Ionicons name="calendar-outline" size={13} color={COLORS.textMedium} />
          <Text style={styles.footerTxt}>{date}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.totalLabel}>{t('orders.paid')}</Text>
          <Text style={styles.total}>{inr(payable)}</Text>
        </View>
      </View>

      {/* ── Order detail ──────────────────────────────────────────────────────
          This app has no separate order-detail screen, so the card is it. Kept
          collapsed by default: the list is the common case and a low-end phone
          should not render every line of every order to show ten of them. */}
      {open ? (
        <View style={styles.detail}>
          {items.map((it, i) => {
            const nm = (language === 'mr' && it.productNameMr) || it.productName
              || it.product?.name || t('orders.itemFallback');
            return (
              <View key={it.id || i} style={styles.detailItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailItemName} numberOfLines={2}>{nm}</Text>
                  <Text style={styles.detailItemMeta}>
                    {t('orders.qty')} {it.quantity} × {inr(it.unitPrice)}
                    {/* A line the seller cancelled is called out: the rest of
                        the order is still coming, and its money is not. */}
                    {it.status === 'CANCELLED' ? ` · ${t('orders.statusCancelled')}` : ''}
                  </Text>
                </View>
                <Text style={styles.detailItemVal}>{inr(it.totalPrice)}</Text>
              </View>
            );
          })}

          <View style={styles.detailRows}>
            {subtotal > 0 ? (
              <View style={styles.breakRow}>
                <Text style={styles.breakLabel}>{t('orders.subtotal', 'Items')}</Text>
                <Text style={styles.breakVal}>{inr(subtotal)}</Text>
              </View>
            ) : null}
            {delivery > 0 ? (
              <View style={styles.breakRow}>
                <Text style={styles.breakLabel}>{t('orders.deliveryFee')}</Text>
                <Text style={styles.breakVal}>{inr(delivery)}</Text>
              </View>
            ) : null}
            {tax > 0 ? (
              <View style={styles.breakRow}>
                <Text style={styles.breakLabel}>{t('orders.tax')}</Text>
                <Text style={styles.breakVal}>{inr(tax)}</Text>
              </View>
            ) : null}
            {discount > 0 ? (
              <View style={styles.breakRow}>
                <Text style={styles.breakLabel}>{t('orders.discount', 'Discount')}</Text>
                <Text style={styles.breakVal}>−{inr(discount)}</Text>
              </View>
            ) : null}
            <View style={styles.breakRow}>
              <Text style={styles.breakLabel}>{t('orders.payment')}</Text>
              <Text style={styles.breakVal}>
                {isCod ? t('checkout.cod', 'Cash on Delivery') : t('orders.paidOnline', 'Paid online')}
              </Text>
            </View>
          </View>

          <RefundLine paymentStatus={order.paymentStatus} />
        </View>
      ) : null}

      <View style={styles.actions}>
        <TouchableOpacity
          onPress={() => setOpen((v) => !v)}
          style={styles.linkBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
        >
          <Text style={styles.linkTxt}>
            {open ? t('orders.hideDetails', 'Hide details') : t('orders.viewDetails', 'View details')}
          </Text>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={COLORS.primary} />
        </TouchableOpacity>

        {cancellable ? (
          <TouchableOpacity
            onPress={askCancel}
            disabled={cancelling}
            style={[styles.cancelBtn, cancelling && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={t('orders.cancelOrder')}
          >
            {cancelling
              ? <ActivityIndicator size="small" color={COLORS.error} />
              : <Text style={styles.cancelTxt}>{t('orders.cancelOrder')}</Text>}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
});

export default function MyOrdersScreen({ navigation }) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const [orders,      setOrders]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [cursor,      setCursor]      = useState(null);
  const [hasMore,     setHasMore]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,       setError]       = useState(null);

  // One request in flight at a time. Without this, FlatList fires onEndReached
  // repeatedly during a fast flick and the same page is appended several times —
  // duplicate rows and duplicate React keys.
  const inFlight = useRef(false);
  const alive    = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /**
   * Keyset (cursor) pagination. The first page opts in with `paginate=cursor`;
   * each later page passes the server-issued `nextCursor`, so page 40 costs the
   * same as page 1.
   */
  const fetchOrders = useCallback(async (cur = null, { refresh = false } = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      if (!cur) setError(null);
      const qs = cur
        ? `cursor=${encodeURIComponent(cur)}&limit=10`
        : 'paginate=cursor&limit=10';
      const { data } = await api.get(`/agristore/orders?${qs}`);
      if (!alive.current) return;

      const items = Array.isArray(data?.data) ? data.data : [];
      const meta  = data?.meta || {};
      setOrders((prev) => (refresh || !cur ? items : [...prev, ...items]));
      setHasMore(Boolean(meta.nextCursor));
      setCursor(meta.nextCursor || null);
    } catch (e) {
      if (!alive.current) return;
      // Only a first-page failure blanks the screen. A failed "load more" leaves
      // the orders already on screen alone — the farmer keeps what they had.
      if (!cur) setError(e?.response?.data?.error?.message || t('orders.loadFailed'));
    } finally {
      inFlight.current = false;
      if (alive.current) { setLoading(false); setRefreshing(false); setLoadingMore(false); }
    }
  }, [t]);

  useEffect(() => { fetchOrders(null); }, [fetchOrders]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrders(null, { refresh: true });
  }, [fetchOrders]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || loading || loadingMore || !cursor || inFlight.current) return;
    setLoadingMore(true);
    fetchOrders(cursor);
  }, [hasMore, loading, loadingMore, cursor, fetchOrders]);

  // Retry the FIRST page. This previously called fetchOrders(1), passing a page
  // number where a cursor was expected — so the retry button never worked.
  const handleRetry = useCallback(() => {
    setLoading(true);
    fetchOrders(null, { refresh: true });
  }, [fetchOrders]);

  /**
   * Fold a completed cancel back into the row, from the SERVER's answer.
   *
   * Refetching the page instead would scroll-jump a farmer who has paged down,
   * and on a village connection it is one more request that can fail after the
   * cancel has already succeeded. Stable identity so `memo(OrderCard)` still
   * holds for every other row.
   */
  const handleCancelled = useCallback((orderId, res) => {
    setOrders((prev) => prev.map((o) => (o.id !== orderId ? o : {
      ...o,
      status: res?.status || 'CANCELLED',
      // Present only when money is actually owed; leaving the old value alone
      // otherwise keeps a cash order from claiming a refund it never had.
      ...(res?.paymentStatus ? { paymentStatus: res.paymentStatus } : {}),
      items: Array.isArray(o.items)
        ? o.items.map((i) => (i.status === 'PENDING' ? { ...i, status: 'CANCELLED' } : i))
        : o.items,
    })));
  }, []);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      {/* The status-bar inset is measured, not assumed. The old `Platform.OS ===
          'android' ? 44 : 12` was wrong on every punch-hole and notched device. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('profile.back', { defaultValue: 'Back' })}
        >
          <Ionicons name="arrow-back" size={24} color={COLORS.textDark} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('myOrders')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading && orders.length === 0 ? (
        /* Same shape as OrderCard — the 56pt item thumb, the name lines and the
           date/total footer row — so nothing shifts when the orders land. */
        <SkeletonList
          rows={5}
          thumb="square"
          thumbSize={56}
          lines={2}
          label={t('loading')}
          style={{ padding: 16 }}
        />
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={COLORS.error} />
          <Text style={styles.errorTxt}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={handleRetry} accessibilityRole="button">
            <Text style={styles.retryTxt}>{t('profile.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <OrderCard order={item} onCancelled={handleCancelled} />}
          contentContainerStyle={
            orders.length ? { padding: 16, paddingBottom: 32 } : { flexGrow: 1 }
          }
          windowSize={5}
          maxToRenderPerBatch={10}
          initialNumToRender={6}
          removeClippedSubviews
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} colors={[COLORS.primary]} />
          }
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          // Only while a page is genuinely in flight. The old condition was
          // `hasMore`, so a spinner sat at the bottom of an idle list forever.
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 16 }} /> : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <DashboardStatIcon type="orders" size={72} />
              <Text style={styles.emptyTitle}>{t('profile.noOrdersYet')}</Text>
              <Text style={styles.emptySubtitle}>{t('profile.ordersAppearHere')}</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surface, paddingHorizontal: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  backBtn:     { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: COLORS.textDark },

  card: {
    backgroundColor: COLORS.surface, borderRadius: 14,
    borderWidth: 1, borderColor: COLORS.border,
    padding: 14,
    shadowColor: COLORS.black, shadowOpacity: 0.05,
    shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  cardHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  orderId:     { fontSize: 13, fontWeight: '700', color: COLORS.textMedium, flex: 1 },
  badge:       { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  badgeTxt:    { fontSize: 12, fontWeight: '700' },

  itemRow:  { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  thumb:    { width: 56, height: 56, borderRadius: 10, backgroundColor: COLORS.grayBg },
  thumbPlaceholder: { justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: COLORS.border },
  productName: { fontSize: 14, fontWeight: '600', color: COLORS.textDark, lineHeight: 20 },
  moreItems:   { fontSize: 12, color: COLORS.textMedium, marginTop: 4 },

  breakdown:  { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 8, marginBottom: 4, gap: 3 },
  breakRow:   { flexDirection: 'row', justifyContent: 'space-between' },
  breakLabel: { fontSize: 12, color: COLORS.textMedium },
  breakVal:   { fontSize: 12, color: COLORS.textMedium, fontWeight: '600' },

  refundRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  refundTxt: { flex: 1, fontSize: 12, fontWeight: '600', color: COLORS.gold },

  detail:         { borderTopWidth: 1, borderTopColor: COLORS.border, marginTop: 10, paddingTop: 10, gap: 8 },
  detailItem:     { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  detailItemName: { fontSize: 13, fontWeight: '600', color: COLORS.textDark },
  detailItemMeta: { fontSize: 11, color: COLORS.textMedium, marginTop: 2 },
  detailItemVal:  { fontSize: 13, fontWeight: '700', color: COLORS.textDark },
  detailRows:     { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 8, gap: 3 },

  actions:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  linkBtn:   { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6 },
  linkTxt:   { fontSize: 13, fontWeight: '700', color: COLORS.primary },
  cancelBtn: {
    minHeight: 34, minWidth: 96, justifyContent: 'center', alignItems: 'center',
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.error,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  cancelTxt: { fontSize: 13, fontWeight: '700', color: COLORS.error },

  cardFooter: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 10,
  },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  footerTxt:  { fontSize: 12, color: COLORS.textMedium },
  totalLabel: { fontSize: 11, color: COLORS.textMedium, marginBottom: 1 },
  total:      { fontSize: 16, fontWeight: '800', color: COLORS.textDark },

  errorTxt:  { fontSize: 15, color: COLORS.error, textAlign: 'center' },
  retryBtn:  { backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10, marginTop: 8 },
  retryTxt:  { color: COLORS.white, fontWeight: '700', fontSize: 15 },

  emptyTitle:    { fontSize: 18, fontWeight: '700', color: COLORS.gray700dark, marginTop: 12 },
  emptySubtitle: { fontSize: 14, color: COLORS.textMedium, textAlign: 'center', marginTop: 4 },
});
