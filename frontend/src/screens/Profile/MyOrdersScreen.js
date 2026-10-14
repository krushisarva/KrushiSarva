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
 *
 * ── Where the goods are ─────────────────────────────────────────────────────
 * The card said nothing about delivery: no date, no shop, no way to ring the
 * person bringing the goods. It now carries, for an order still on its way:
 *
 *   - "Arriving by 16 Oct" — and, once that day has passed, "running late"
 *     instead of a date in the past dressed up as a promise;
 *   - one block per shop: its name, a Call button while it is delivering, and
 *     its own status when the order has more than one shop;
 *   - the DELIVERY CODE, once the goods have left the shop. The farmer reads it
 *     to the delivery person at the door; it is what proves the hand-over.
 *
 * All of it sits on the COLLAPSED card. A farmer standing at their door with
 * the seller waiting should not have to find and open a detail view to read
 * four digits. It costs the list nothing: only an order in transit renders it,
 * and a farmer has one or two of those, not ten.
 *
 * Every decision — is it late, which shop gets which code, what an older
 * backend that sends none of this looks like — is in shopUtils.js, where it is
 * unit-tested. This file only lays the answers out. The code is rendered and
 * nothing else: it is never logged, cached or passed to another screen.
 *
 * ── Rating what arrived ─────────────────────────────────────────────────────
 * The server has always accepted a review of a delivered product, and no screen
 * in the app could send one. Each DELIVERED line now carries "Rate this
 * product" — or, once rated, the stars the farmer gave and "Edit". It is on the
 * collapsed card for the same reason the delivery code is: a button nobody
 * finds is a review nobody writes. Which lines can be rated is in
 * reviewUtils.js; the sheet itself is components/ReviewSheet.js, one for the
 * whole list.
 *
 * ── One card, read top to bottom ────────────────────────────────────────────
 * The card had grown by accretion: the order id in bold as the first thing on
 * it, three hairlines, a lone "Delivery ₹49" row between two of them, and the
 * total at the far end under the label "Paid" — printed on cash orders nobody
 * had paid for, and on cancelled ones. Opening the detail put the items BELOW
 * that total. It now reads in the order a farmer asks:
 *
 *   when, and which order (quiet)          what state it is in (loud)
 *   what I bought · how many · what it costs and how it is paid
 *   where it is: arriving-by, the shop, Call, the delivery code
 *   rate it / where my refund is
 *   ─────────────
 *   View details                                          Cancel order
 *
 * The amount sits with the product it is the price of, beside the words for
 * how it is paid (orderPaymentLabel in shopUtils.js — "Cash on Delivery", never
 * "Paid", for cash). The delivery and tax lines live in the detail, where they
 * add up to a Total. One hairline is left, above the actions.
 *
 * Motion is small and only where something appears: the first screenful of
 * cards rises in once, and the detail fades in and out. Both use the native
 * driver, and neither happens under the system's reduced-motion setting. Rows
 * that mount later — scrolling, load-more — appear at once: a list that
 * animates while it is being scrolled is the opposite of smooth.
 *
 * On a wide screen (a tablet, a browser) the column is capped and centred, so
 * the card is never stretched across a metre of glass with its buttons at
 * opposite ends.
 *
 * ── Tracking ────────────────────────────────────────────────────────────────
 * The badge says what state an order is in; it never showed the road. Opening
 * a card now leads with the timeline — placed, confirmed by the shop, out for
 * delivery, delivered, each with the time it happened, or the cancel, the
 * failed delivery and the refund where that is how it ended — with the receipt
 * below it. While something is still on its way the button that opens it reads
 * "Track order", because that is the question being asked; on a finished order
 * it stays "View details". The steps are worked out in orderTracking.js and
 * drawn by components/OrderTimeline.js, and only for a card that is open.
 */
import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl, Animated, Easing,
} from 'react-native';
import { showPopup } from '../../utils/popup';
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
  orderRefundLabel, canCancelOrder, cancelRefundPreview, orderPaymentLabel,
  orderStatusLabel, orderEta, orderDeliveries, deliveryBreakdownLines,
} from '../AgriStore/shopUtils';
import { cancelOrder } from '../AgriStore/shopClient';
import { reviewableItems, myReviewOf, applyMyReview } from '../AgriStore/reviewUtils';
import { isOrderLive } from '../AgriStore/orderTracking';
import OrderTimeline from '../../components/OrderTimeline';
import ReviewSheet from '../../components/ReviewSheet';
import Stars from '@krushisarva/shared/components/Stars';
// The app's one answer to "has this person asked for less motion?".
import { isReducedMotion } from '@krushisarva/shared/components/ui/motion';
// The app's one way to open a `tel:` link: scheme-allowlisted, and it TRIES the
// link rather than asking canOpenURL first — which answers false for `tel:` on
// Android 11+ unless the manifest declares the query, and would hide a dialler
// that works.
import { safeOpenURL, sanitizePhone } from '../../utils/sanitize';

/** ₹ with Indian digit grouping (1,20,000 — not 120,000). */
function inr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₹0';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Every member of the OrderStatus enum is represented. REFUNDED was missing,
// which meant a refunded order showed the raw string "REFUNDED" in grey — the
// one status where the farmer most needs a clear answer.
//
// Colours and the per-shop icon only. The WORDS come from orderStatusLabel() in
// shopUtils.js, so the badge and each shop's own status line cannot disagree —
// SHIPPED reads "Out for delivery" in both.
//
// The text colours are the DARK member of each family, on its pale one. They
// were the bright ones — gold on pale gold, emerald on mint, red on pink — which
// measure between 1.9:1 and 3.3:1: a badge that cannot be read in sunlight on
// the one line that says where the order is. These are all above 4.5:1.
const STATUS_META = {
  PENDING:   { color: COLORS.orange700,  bg: COLORS.goldPale,   icon: 'hourglass-outline' },
  CONFIRMED: { color: COLORS.blue,       bg: COLORS.bluePale,   icon: 'checkmark-circle-outline' },
  SHIPPED:   { color: COLORS.purpleDark, bg: COLORS.violetPale, icon: 'navigate-outline' },
  DELIVERED: { color: COLORS.green800,   bg: COLORS.mintPale,   icon: 'checkmark-done-circle-outline' },
  CANCELLED: { color: COLORS.errorDark,  bg: COLORS.errorLight, icon: 'close-circle-outline' },
  REFUNDED:  { color: COLORS.textBody,   bg: COLORS.grayBg,     icon: 'ellipse-outline' },
};

/** How wide the column of cards may grow on a tablet or in a browser. */
const CONTENT_MAX_WIDTH = 640;
/** Only the first screenful of cards rises in; see the header. */
const ENTRANCE_ROWS = 6;

/** A status label from shopUtils → text. `key` is null for a status this build does not know. */
const statusText = (label, t) => (label?.key ? t(label.key, label.fallback) : label?.fallback || null);

function StatusBadge({ status }) {
  const { t } = useLanguage();
  const meta = STATUS_META[status];
  // An unknown status — a value added to the OrderStatus enum after this APK
  // shipped — used to render the raw code, so a farmer was shown the literal
  // word "RETURN_REQUESTED". It degrades to a title-cased phrase instead: not a
  // translation, but a readable one that cannot be WRONG the way a guess can.
  // A status that is missing altogether shows nothing rather than an empty pill.
  const label = statusText(orderStatusLabel(status), t);
  if (!label) return null;
  const tone = meta?.color || COLORS.textBody;
  return (
    <View style={[styles.badge, { backgroundColor: meta?.bg || COLORS.grayBg }]}>
      {/* A shape as well as a colour: six statuses in six tints are not six
          things to someone who cannot tell the tints apart. */}
      <Ionicons name={meta?.icon || 'ellipse-outline'} size={13} color={tone} />
      <Text style={[styles.badgeTxt, { color: tone }]} numberOfLines={1}>{label}</Text>
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
function RefundLine({ paymentStatus, paymentMethod }) {
  const { t } = useLanguage();
  const label = orderRefundLabel(paymentStatus, paymentMethod);
  if (!label) return null;
  // Dark enough to read: this is the line a farmer comes back to check, and the
  // gold and emerald it used to be printed in are about 2:1 on white.
  const tone = label.done ? COLORS.green800 : COLORS.orange700;
  return (
    <View style={styles.refundRow}>
      <Ionicons name={label.done ? 'checkmark-circle' : 'time-outline'} size={15} color={tone} />
      <Text style={[styles.refundTxt, { color: tone }]}>{t(label.key, label.fallback)}</Text>
    </View>
  );
}

/**
 * The delivery code.
 *
 * Large and spaced, because it is read off the screen and SAID to someone, on a
 * doorstep, often in sunlight. The sentence under it is the instruction that
 * makes the code worth having: handed over before the goods are, it proves
 * nothing.
 *
 * One accessible element, labelled as a whole. Left to itself a screen reader
 * announces the digits as "four thousand and seventy-two", which is not what
 * the delivery person has to type; `code.spoken` is the digits one at a time.
 * The label repeats the shop name whenever there is more than one shop, so a
 * farmer listening rather than looking still knows whose code they are hearing.
 */
function DeliveryCode({ code, shop }) {
  const { t } = useLanguage();
  const title = shop
    ? t('orders.deliveryCodeFor', { shop, defaultValue: 'Delivery code for {{shop}}' })
    : t('orders.deliveryCode', 'Delivery code');
  const hint = t(
    'orders.deliveryCodeHint',
    'Give this code to the delivery person only after you have received your goods.',
  );
  return (
    <View
      style={styles.codeBox}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${title}: ${code.spoken}. ${hint}`}
    >
      <Text style={styles.codeTitle}>{title}</Text>
      {/* Shrinks to fit rather than wrapping: at 200% system text four digits
          must still be ONE line, or "40" and "72" read as two numbers. */}
      <Text style={styles.codeDigits} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {code.spaced}
      </Text>
      <Text style={styles.codeHint}>{hint}</Text>
    </View>
  );
}

/**
 * One shop's part of the delivery: who, how far along, how to ring them, and
 * the code to give them.
 *
 * `compact` is the single-shop order — nearly all of them. The order badge
 * already says the status and the item row already names the goods, so this is
 * one line: the shop and a Call button. With several shops each one is boxed,
 * and the box is what ties a code to its shop: two shops mean two different
 * codes, and giving the wrong one fails the delivery at the door.
 */
const ShopBlock = memo(function ShopBlock({ block, compact }) {
  const { t } = useLanguage();

  // A shop the server could not name still needs something to be called, and
  // with two of them it has to be something that tells them apart.
  const shop = block.name || (compact
    ? t('orders.shopFallback', 'Shop')
    : t('orders.shopNumbered', { n: block.ordinal, defaultValue: 'Shop {{n}}' }));
  const status = block.showStatus ? statusText(block.statusLabel, t) : null;
  const meta = STATUS_META[block.status];

  const itemsLine = block.itemNames.length
    ? block.itemNames.join(', ') + (block.moreItems > 0
      ? ` ${t(block.moreItems > 1 ? 'orders.moreItemsPlural' : 'orders.moreItem', { count: block.moreItems })}`
      : '')
    : null;

  const call = useCallback(async () => {
    const ok = await safeOpenURL(`tel:${sanitizePhone(block.phone)}`);
    // A tablet with no dialler, or a phone that refused the link. Showing the
    // number is what lets the farmer still make the call, from another phone if
    // need be.
    if (!ok) {
      showPopup(
        t('orders.callFailedTitle', 'Could not start the call'),
        t('orders.callFailedMsg', {
          shop, phone: block.phone,
          defaultValue: 'Please dial {{phone}} to reach {{shop}}.',
        }),
      );
    }
  }, [block.phone, shop, t]);

  return (
    <View style={compact ? styles.shop : [styles.shop, styles.shopBoxed]}>
      <View style={styles.shopRow}>
        <View style={styles.shopInfo}>
          <View style={styles.shopLine}>
            <Ionicons name="storefront-outline" size={15} color={COLORS.textMedium} />
            <Text style={styles.shopName} numberOfLines={2}>{shop}</Text>
          </View>
          {/* Words AND an icon — the status is never carried by colour. */}
          {status ? (
            <View style={styles.shopLine}>
              <Ionicons name={meta?.icon || 'ellipse-outline'} size={15} color={COLORS.textBody} />
              <Text style={styles.shopStatus}>{status}</Text>
            </View>
          ) : null}
          {itemsLine ? <Text style={styles.shopItems} numberOfLines={2}>{itemsLine}</Text> : null}
        </View>

        {block.phone ? (
          <TouchableOpacity
            onPress={call}
            style={styles.callBtn}
            accessibilityRole="button"
            // Names the shop: with two Call buttons on one card, "Call shop"
            // twice tells a screen-reader user nothing.
            accessibilityLabel={t('orders.callShopNamed', { shop, defaultValue: 'Call {{shop}}' })}
          >
            <Ionicons name="call" size={16} color={COLORS.primary} />
            <Text style={styles.callTxt}>{t('orders.callShop', 'Call shop')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Inside the shop's own block, and named for it when there are several. */}
      {block.code ? <DeliveryCode code={block.code} shop={compact ? null : shop} /> : null}
    </View>
  );
});

/**
 * Everything about delivery for one order: the promised date, then the shops.
 *
 * Renders NOTHING — not an empty container — for a finished order, and for a
 * response from a backend that predates these fields and has no promised date
 * on the order either. In both cases the card is exactly what it was before.
 *
 * Memoised on the order object. The list replaces a row's object only when that
 * row changes, so opening and closing a card's detail recomputes none of this.
 */
function DeliverySection({ order }) {
  const { t, language } = useLanguage();
  const eta = useMemo(() => orderEta(order), [order]);
  const { compact, blocks } = useMemo(() => orderDeliveries(order, { language }), [order, language]);

  if (!eta && !blocks.length) return null;
  return (
    <View style={styles.delivery}>
      {eta ? (
        <View style={styles.etaRow}>
          {/* A different icon as well as a different colour when it is late. */}
          <Ionicons
            name={eta.late ? 'alert-circle' : 'time-outline'}
            size={16}
            color={eta.late ? COLORS.orange700 : COLORS.primary}
          />
          <Text style={[styles.etaTxt, eta.late && styles.etaLate]}>
            {t(eta.key, { date: eta.dateText, defaultValue: eta.fallback })}
          </Text>
        </View>
      ) : null}
      {blocks.map((b) => <ShopBlock key={b.key} block={b} compact={compact} />)}
    </View>
  );
}

const OrderCard = memo(function OrderCard({ order, index = 0, entrance, onCancelled, onRate }) {
  const { t, language } = useLanguage();
  const [imgFailed, setImgFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // ── The detail: `expanded` is what the farmer asked for, `mounted` is whether
  // the block is in the tree. They differ for the 140ms it takes to fade out —
  // the words on the button change at once, the rows leave when the fade ends.
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const detailAnim = useRef(new Animated.Value(0)).current;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const toggleDetail = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    detailAnim.stopAnimation();
    if (isReducedMotion()) {
      detailAnim.setValue(next ? 1 : 0);
      setMounted(next);
      return;
    }
    if (next) {
      setMounted(true);
      Animated.timing(detailAnim, {
        toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(detailAnim, {
        toValue: 0, duration: 140, easing: Easing.in(Easing.cubic), useNativeDriver: true,
      }).start(({ finished }) => {
        // Not if it was reopened mid-fade (that run was stopped, `finished` is
        // false), and not on a card that has scrolled away.
        if (finished && alive.current) setMounted(false);
      });
    }
  }, [expanded, detailAnim]);

  // ── The entrance. Decided ONCE, when the card mounts: the first screenful of
  // the first load rises in; a card that mounts later (scrolling, load-more)
  // is simply there. See "Motion" in the header.
  const rises = useRef(index < ENTRANCE_ROWS && entrance?.current === true && !isReducedMotion()).current;
  const enter = useRef(new Animated.Value(rises ? 0 : 1)).current;
  useEffect(() => {
    if (!rises) return undefined;
    const run = Animated.timing(enter, {
      toValue: 1, duration: 260, delay: index * 45, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
    // Mount only: `rises` and `index` are fixed for the life of the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Built ONCE per card. Written inline in the JSX, each render made new
  // interpolation nodes, and React Native then detached and re-attached this
  // card's native animation — on the very tap that starts the fade.
  const riseStyle = useMemo(() => (rises
    ? { transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }
    : null), [rises, enter]);
  const fadeStyle = useMemo(() => (rises ? { opacity: enter } : null), [rises, enter]);
  const detailStyle = useMemo(() => ({
    opacity: detailAnim,
    transform: [{ translateY: detailAnim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }],
  }), [detailAnim]);
  const chevronStyle = useMemo(() => ({
    transform: [{ rotate: detailAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }],
  }), [detailAnim]);

  // Snapshot first, live join second — see the header.
  const nameOf = (it) => (language === 'mr' && it?.productNameMr) || it?.productName
    || it?.product?.name || t('orders.itemFallback');
  // The lines that have ARRIVED. Only those can be rated.
  const rateable = reviewableItems(order);
  // Still on its way? Then opening the card is "Track order". A cheap check —
  // the timeline itself is only built once the card is open.
  const live = isOrderLive(order);

  const items = Array.isArray(order.items) ? order.items : [];
  const firstItem = items[0];
  const itemName = nameOf(firstItem);
  const itemImg = firstItem?.productImage || firstItem?.product?.images?.[0];
  const firstQty = Number(firstItem?.quantity);
  const extraCount = Math.max(items.length - 1, 0);
  // "Qty 2 · +1 more item" — how much of it, and whether it came alone.
  const summaryLine = [
    Number.isFinite(firstQty) && firstQty > 0 ? `${t('orders.qty')} ${firstQty}` : null,
    extraCount > 0
      ? t(extraCount > 1 ? 'orders.moreItemsPlural' : 'orders.moreItem', { count: extraCount })
      : null,
  ].filter(Boolean).join(' · ');

  // `totalAmount` is THE PAYABLE (goods + delivery + tax − discount) since the
  // Shop hardening pass. `total` is kept as a fallback only so an older cached
  // response cannot blank the figure out.
  const payable = Number(order.totalAmount ?? order.total ?? 0);
  // How it is paid, in words that are true for a cash order too. Null when the
  // order does not say — then the amount stands alone.
  const payment = orderPaymentLabel(order);
  const paymentText = payment ? t(payment.key, payment.fallback) : null;

  const date = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;
  const shortId = order.id ? `#${order.id.slice(-8).toUpperCase()}` : null;

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

    showPopup(
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
      showPopup(
        t('orders.cancelledTitle', 'Order cancelled'),
        Number.isFinite(refunded) && refunded > 0
          ? t('orders.cancelledRefundMsg', {
            amount: inr(refunded),
            defaultValue: '{{amount}} is being refunded to the account you paid from — it usually arrives in 5–7 working days.',
          })
          : t('orders.cancelledNoRefundMsg', 'Your order has been cancelled.'),
      );
    } catch (err) {
      showPopup(
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
    // Two layers on purpose. The SHELL (the white card, its border and shadow)
    // only slides; the BODY inside it is what fades. Fading the shell itself
    // would fade a view that has elevation, which Android draws as a dark
    // rectangle showing through until the fade ends.
    <Animated.View style={[styles.card, riseStyle]}>
      <Animated.View style={[styles.cardBody, fadeStyle]}>
        {/* When, and which order — quiet. What state it is in — loud. Two lines
            are allowed: beside a long status on a narrow phone the order number
            drops under the date rather than being cut off mid-number. */}
        <View style={styles.cardHeader}>
          <Text style={styles.meta} numberOfLines={2}>
            {[date, shortId].filter(Boolean).join(' · ')}
          </Text>
          <StatusBadge status={order.status} />
        </View>

        {/* What was bought, how much of it, and what it costs — together,
            because the amount is the price of THIS. */}
        <View style={styles.itemRow}>
          {itemImg && !imgFailed ? (
            <Image source={{ uri: itemImg }} style={styles.thumb} onError={() => setImgFailed(true)} />
          ) : (
            <View style={[styles.thumb, styles.thumbPlaceholder]}>
              <Ionicons name="cube-outline" size={22} color={COLORS.textMedium} />
            </View>
          )}
          <View style={styles.itemInfo}>
            <Text style={styles.productName} numberOfLines={2}>{itemName}</Text>
            {summaryLine ? <Text style={styles.itemSub} numberOfLines={1}>{summaryLine}</Text> : null}
            {/* One announcement, "₹609.00, Cash on Delivery" — and it wraps as
                two lines rather than squeezing when the words are long. */}
            <View
              style={styles.priceRow}
              accessible
              accessibilityLabel={[inr(payable), paymentText].filter(Boolean).join(', ')}
            >
              <Text style={styles.total}>{inr(payable)}</Text>
              {paymentText ? <Text style={styles.payment}>{paymentText}</Text> : null}
            </View>
          </View>
        </View>

        {/* When it is coming, who is bringing it, and the code to give them. On
            the collapsed card on purpose — see "Where the goods are" in the
            header. Nothing at all for a finished order or an older backend. */}
        <DeliverySection order={order} />

        {/* One row per line that has arrived: rate it, or see and change the
            rating already given. Named only when the order has more than one
            product — on a one-product order the name is already right above. */}
        {rateable.length ? (
          <View style={styles.rateBlock}>
            {rateable.map((it) => {
              const nm = nameOf(it);
              const mine = myReviewOf(it);
              const single = items.length === 1;
              return (
                <TouchableOpacity
                  key={it.id}
                  style={[styles.rateBtn, mine && styles.rateBtnDone]}
                  onPress={() => onRate?.(order, it, nm)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={mine
                    ? t('reviews.a11yEdit', {
                      count: mine.rating, name: nm,
                      defaultValue: 'You rated {{name}} {{count}} of 5 stars. Change your rating',
                    })
                    : t('reviews.rateNamed', { name: nm, defaultValue: 'Rate {{name}}' })}
                >
                  {mine
                    ? <Stars value={mine.rating} size={16} />
                    : <Ionicons name="star-outline" size={18} color={COLORS.primary} />}
                  <Text style={[styles.rateTxt, mine && styles.rateTxtDone]} numberOfLines={2}>
                    {mine
                      ? (single ? t('reviews.yourRating', 'Your rating') : nm)
                      : (single
                        ? t('reviews.rateThis', 'Rate this product')
                        : t('reviews.rateNamed', { name: nm, defaultValue: 'Rate {{name}}' }))}
                  </Text>
                  {mine
                    ? <Text style={styles.rateEdit}>{t('reviews.edit', 'Edit')}</Text>
                    : <Ionicons name="chevron-forward" size={16} color={COLORS.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}

        {/* Where the money actually is. On the collapsed card: a farmer checking
            whether their refund has come should not have to open anything to
            find out. Once here, not again inside the detail. */}
        <RefundLine paymentStatus={order.paymentStatus} paymentMethod={order.paymentMethod} />

        {/* ── Order detail ────────────────────────────────────────────────────
            This app has no separate order-detail screen, so the card is it.
            Kept out of the tree until asked for: the list is the common case
            and a low-end phone should not build every line of every order to
            show ten of them. */}
        {mounted ? (
          <Animated.View style={[styles.detailWrap, detailStyle]}>
            {/* The road first, the receipt second: someone opening an order that
                is on its way is asking where it is, not what it cost. */}
            <OrderTimeline order={order} />
            <View style={styles.detail}>
              <OrderDetail order={order} shortId={shortId} payable={payable} paymentText={paymentText} />
            </View>
          </Animated.View>
        ) : null}

        {/* The one hairline on the card: everything above is the order, this is
            what can be done about it. */}
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={toggleDetail}
            style={styles.linkBtn}
            activeOpacity={0.6}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
          >
            <Text style={styles.linkTxt}>
              {expanded
                ? t('orders.hideDetails', 'Hide details')
                : (live ? t('orders.trackOrder', 'Track order') : t('orders.viewDetails', 'View details'))}
            </Text>
            <Animated.View style={chevronStyle}>
              <Ionicons name="chevron-down" size={16} color={COLORS.primary} />
            </Animated.View>
          </TouchableOpacity>

          {cancellable ? (
            <TouchableOpacity
              onPress={askCancel}
              disabled={cancelling}
              style={[styles.cancelBtn, cancelling && { opacity: 0.6 }]}
              activeOpacity={0.7}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={t('orders.cancelOrder')}
              accessibilityState={{ disabled: cancelling, busy: cancelling }}
            >
              {cancelling
                ? <ActivityIndicator size="small" color={COLORS.errorDark} />
                : <Text style={styles.cancelTxt}>{t('orders.cancelOrder')}</Text>}
            </TouchableOpacity>
          ) : null}
        </View>
      </Animated.View>
    </Animated.View>
  );
});

/**
 * The opened detail: every line of the order, then how the total is made up.
 *
 * Its own component so that none of this — the per-line names, the delivery
 * split — is worked out for a card that is closed, which is nearly all of them.
 * It ends on the Total: the rows above add up to it, and a column of charges
 * with no sum under it leaves the farmer to do the arithmetic.
 */
const OrderDetail = memo(function OrderDetail({ order, shortId, payable, paymentText }) {
  const { t, language } = useLanguage();
  const items = Array.isArray(order.items) ? order.items : [];
  const subtotal = Number(order.subtotal ?? 0);
  const delivery = Number(order.deliveryFee ?? 0);
  const tax = Number(order.taxAmount ?? 0);
  const discount = Number(order.discountAmount ?? 0);
  // What the delivery charge was made of, as frozen on the order when it was
  // placed. Empty for an order that paid only the standard fee, and for one
  // placed before the split was recorded.
  const deliveryLines = deliveryBreakdownLines(order.pricingSnapshot);

  return (
    <>
      {/* The order number, in full and selectable. The card's first line shows
          it too, but that line gives way to a long status on a narrow phone —
          and this is the number a farmer reads out to the shop or to support. */}
      {shortId ? (
        <View style={styles.breakRow}>
          <Text style={styles.breakLabel}>{t('orderConfirmed.orderId', 'Order ID')}</Text>
          <Text style={styles.breakVal} selectable>{shortId}</Text>
        </View>
      ) : null}

      {items.map((it, i) => {
        // Snapshot first, live join second — see the header.
        const nm = (language === 'mr' && it.productNameMr) || it.productName
          || it.product?.name || t('orders.itemFallback');
        return (
          <View key={it.id || i} style={styles.detailItem}>
            <View style={styles.detailItemInfo}>
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
        {/* Shown only when the farmer actually paid these — a ₹0 delivery line
            is noise, and printing "Tax ₹0" invites the question of why. */}
        {delivery > 0 ? (
          <View style={styles.breakRow}>
            <Text style={styles.breakLabel}>{t('orders.deliveryFee')}</Text>
            <Text style={styles.breakVal}>{inr(delivery)}</Text>
          </View>
        ) : null}
        {/* What that delivery figure is made of — the same split the cart
            showed before paying. Indented: parts of the line above, not
            further charges. */}
        {deliveryLines.map((line) => (
          <View key={line.id} style={[styles.breakRow, styles.breakSubRow]}>
            <Text style={styles.breakLabel}>{t(line.key, line.fallback)}</Text>
            <Text style={styles.breakVal}>{line.free ? t('free') : inr(line.amount)}</Text>
          </View>
        ))}
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
        {/* Only when the order says how it is paid; see orderPaymentLabel. */}
        {paymentText ? (
          <View style={styles.breakRow}>
            <Text style={styles.breakLabel}>{t('orders.payment')}</Text>
            <Text style={styles.breakVal}>{paymentText}</Text>
          </View>
        ) : null}
        <View style={[styles.breakRow, styles.totalRow]}>
          <Text style={styles.totalRowLabel}>{t('product.totalLabel', 'Total')}</Text>
          <Text style={styles.totalRowVal}>{inr(payable)}</Text>
        </View>
      </View>
    </>
  );
});

// At module scope on purpose. Written inline they are a NEW component and a new
// function on every render of the screen, and React then unmounts and remounts
// every separator in the list each time a page loads or the review sheet opens.
const Separator = () => <View style={styles.separator} />;
const orderKey = (item) => item.id;

export default function MyOrdersScreen({ navigation, route }) {
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

  /**
   * Arriving from a tapped push ("Order shipped") while this screen is ALREADY
   * open somewhere in the Account stack.
   *
   * The list on screen was loaded before the seller moved the order, so without
   * this the farmer taps the notification and is shown the old status — and no
   * delivery code, which is the thing they tapped for. `pushKey` identifies the
   * tap (utils/pushRoute.js); a new one reloads the first page, once.
   *
   * The key this screen MOUNTED with is treated as already seen: the mount
   * effect above is fetching that page right now, and a second identical
   * request beside it is exactly the duplicate this app keeps removing.
   */
  const pushKey = route?.params?.pushKey;
  const seenPushKey = useRef(pushKey);
  useEffect(() => {
    if (pushKey === seenPushKey.current) return;
    seenPushKey.current = pushKey;
    handleRefresh();
  }, [pushKey, handleRefresh]);

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
      // The per-shop delivery entries follow their lines, so the row does not
      // keep saying a shop is still bringing an order that was just cancelled.
      // Only when the server sent them — an older backend's row gains no field.
      ...(Array.isArray(o.deliveries) ? {
        deliveries: o.deliveries.map((d) => (d?.status === 'PENDING'
          ? { ...d, status: 'CANCELLED', sellerPhone: null, deliveryCode: null }
          : d)),
      } : {}),
    })));
  }, []);

  /**
   * The line being rated, or null. One sheet for the whole list, opened by any
   * card — a Modal per card would be ten Modals mounted to show ten orders.
   * Both callbacks keep a stable identity so `memo(OrderCard)` still holds.
   */
  const [reviewTarget, setReviewTarget] = useState(null);
  const handleRate = useCallback((order, item, name) => {
    setReviewTarget({
      orderId: order.id, orderItemId: item.id, productId: item.productId,
      name, review: myReviewOf(item),
    });
  }, []);
  const closeReview = useCallback(() => setReviewTarget(null), []);
  // Fold the saved rating into the row from the server's answer — the row
  // turning into the stars just given is the confirmation.
  const handleReviewSaved = useCallback((target, review) => {
    setOrders((prev) => applyMyReview(prev, target.orderId, target.orderItemId, review));
    setReviewTarget(null);
  }, []);

  /**
   * The gate for the cards' entrance. Open for the first commit that has orders
   * in it — the first screenful mounts in that commit and rises in — and closed
   * from then on, so a card mounted by scrolling, by load-more or after a
   * refresh is simply there. A ref, not state: closing it must not re-render
   * anything, and the object's identity never changes, so memo(OrderCard) holds.
   */
  const entrance = useRef(true);
  const hasOrders = orders.length > 0;
  useEffect(() => { if (hasOrders) entrance.current = false; }, [hasOrders]);

  const renderOrder = useCallback(({ item, index }) => (
    <OrderCard
      order={item}
      index={index}
      entrance={entrance}
      onCancelled={handleCancelled}
      onRate={handleRate}
    />
  ), [handleCancelled, handleRate]);

  return (
    <SafeAreaView style={styles.root} edges={['bottom']}>
      {/* The status-bar inset is measured, not assumed. The old `Platform.OS ===
          'android' ? 44 : 12` was wrong on every punch-hole and notched device. */}
      {/* The bar spans the screen; what is IN it lines up with the cards below,
          so on a wide screen the back arrow is not a metre from the list. */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={[styles.headerRow, styles.column]}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.goBack', 'Go back')}
          >
            <Ionicons name="arrow-back" size={24} color={COLORS.textDark} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} accessibilityRole="header">{t('myOrders')}</Text>
          <View style={{ width: 40 }} />
        </View>
      </View>

      {loading && orders.length === 0 ? (
        /* Same shape as OrderCard — the 56pt item thumb beside the name, the
           sub-line and the price — so nothing shifts when the orders land. */
        <SkeletonList
          rows={5}
          thumb="square"
          thumbSize={56}
          lines={3}
          label={t('loading')}
          style={[styles.listContent, styles.column]}
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
          keyExtractor={orderKey}
          renderItem={renderOrder}
          contentContainerStyle={
            orders.length ? [styles.listContent, styles.column] : styles.listEmpty
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
          ItemSeparatorComponent={Separator}
        />
      )}

      <ReviewSheet target={reviewTarget} onClose={closeReview} onSaved={handleReviewSaved} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },

  // On a phone this changes nothing. On a tablet or in a browser it is what
  // keeps a card from being stretched edge to edge.
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' },
  listContent: { padding: 16, paddingBottom: 32 },
  listEmpty:   { flexGrow: 1 },
  separator:   { height: 12 },

  header: {
    backgroundColor: COLORS.surface, paddingHorizontal: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerRow:   { flexDirection: 'row', alignItems: 'center' },
  backBtn:     { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: COLORS.textDark },

  // The shell. Its spacing is ONE number: the body lays its blocks out 12 apart,
  // so a block that is not there (no delivery, no refund) leaves no gap behind —
  // which a margin on each block could not promise.
  card: {
    backgroundColor: COLORS.surface, borderRadius: 14,
    borderWidth: 1, borderColor: COLORS.border,
    padding: 14,
    shadowColor: COLORS.black, shadowOpacity: 0.05,
    shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  cardBody:    { gap: 12 },

  cardHeader:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Takes what the badge leaves, and wraps when that is not enough.
  meta:        { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, fontWeight: '500', color: COLORS.textMedium },
  // Never squeezed: the status is the loudest thing on the card. Capped so that
  // even a long one leaves the date readable.
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    flexShrink: 0, maxWidth: '64%',
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4,
  },
  badgeTxt:    { flexShrink: 1, fontSize: 12, fontWeight: '700' },

  // Top-aligned: the text beside the picture is three lines now, and a picture
  // centred against three lines drifts away from the name it belongs to.
  itemRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  thumb:    { width: 56, height: 56, borderRadius: 10, backgroundColor: COLORS.grayBg },
  thumbPlaceholder: { justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: COLORS.border },
  itemInfo:    { flex: 1, minWidth: 0, gap: 3 },
  productName: { fontSize: 15, fontWeight: '600', color: COLORS.textDark, lineHeight: 21 },
  itemSub:     { fontSize: 12, color: COLORS.textMedium },
  // Wraps: at a large font size, or in a long language, the words for how it is
  // paid drop under the amount instead of pushing it off the card.
  priceRow:    { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2, marginTop: 3 },
  total:       { fontSize: 16, fontWeight: '800', color: COLORS.textDark },
  payment:     { fontSize: 12, fontWeight: '600', color: COLORS.textMedium },

  breakRow:   { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  // A part of the delivery line above it, not a further charge.
  breakSubRow: { paddingLeft: 12 },
  // Label and value are told apart by weight, both dark enough for the panel.
  breakLabel: { flexShrink: 1, fontSize: 13, color: COLORS.textBody },
  breakVal:   { fontSize: 13, color: COLORS.textDark, fontWeight: '600' },
  // What the rows above add up to.
  totalRow:      { marginTop: 5, paddingTop: 9, borderTopWidth: 1, borderTopColor: COLORS.borderMedium },
  totalRowLabel: { fontSize: 14, fontWeight: '700', color: COLORS.textDark },
  totalRowVal:   { fontSize: 15, fontWeight: '800', color: COLORS.textDark },

  refundRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // The colour is set where the line is drawn: it depends on whether the money
  // is still on its way.
  refundTxt: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 18 },

  // ── Rate what arrived ───────────────────────────────────────────────────────
  rateBlock: { gap: 8 },
  // 48dp tall: a thumb target, like the Call button.
  rateBtn: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.primary,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  // Already rated: quieter — it is a record now, not a thing left to do.
  rateBtnDone: { borderColor: COLORS.border, backgroundColor: COLORS.surfaceRaised },
  rateTxt:     { flex: 1, fontSize: 13, fontWeight: '700', color: COLORS.primary },
  rateTxtDone: { color: COLORS.textBody, fontWeight: '600' },
  rateEdit:    { fontSize: 13, fontWeight: '700', color: COLORS.primary },

  // ── Delivery ────────────────────────────────────────────────────────────────
  delivery: { gap: 10 },
  etaRow:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  etaTxt:   { flex: 1, fontSize: 13, fontWeight: '700', color: COLORS.textDark },
  // orange700 on white is ~5.6:1 — AA for text this size. The gold used by the
  // refund line is not, and "running late" must not be the least readable thing
  // on the card.
  etaLate:  { color: COLORS.orange700 },

  shop:       { gap: 10 },
  // Only when there is more than one shop: the box is what ties a code to it.
  shopBoxed:  {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 12,
    backgroundColor: COLORS.surfaceRaised, padding: 10,
  },
  shopRow:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  shopInfo:   { flex: 1, gap: 4 },
  shopLine:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shopName:   { flex: 1, fontSize: 13, fontWeight: '700', color: COLORS.textDark },
  shopStatus: { flex: 1, fontSize: 12, fontWeight: '600', color: COLORS.textBody },
  shopItems:  { fontSize: 12, color: COLORS.textMedium, lineHeight: 17 },
  // 48dp in both directions — a thumb target, used one-handed with goods in the
  // other. Capped in width so a long translation cannot squeeze the shop name
  // out of the row; the label wraps instead.
  callBtn: {
    minHeight: 48, minWidth: 48, maxWidth: '55%',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.primary,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  callTxt: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: COLORS.primary },

  codeBox: {
    alignItems: 'center', gap: 4,
    borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.primary,
    backgroundColor: COLORS.primarySoft, paddingVertical: 12, paddingHorizontal: 14,
  },
  codeTitle:  { fontSize: 12, fontWeight: '700', color: COLORS.primary, textAlign: 'center' },
  // The spacing between digits is real spaces (shopUtils `spaced`), not
  // letterSpacing alone: Android adds letterSpacing after the LAST glyph too,
  // which pushes a centred number visibly off-centre.
  codeDigits: {
    fontSize: 34, fontWeight: '800', color: COLORS.textDark,
    fontVariant: ['tabular-nums'], textAlign: 'center',
  },
  codeHint:   { fontSize: 12, color: COLORS.textBody, textAlign: 'center', lineHeight: 17 },

  // The opened part: the timeline, then the receipt, the same distance apart
  // as everything else on the card.
  detailWrap: { gap: 12 },
  // A tinted panel rather than more lines: the detail is a different KIND of
  // thing from the card around it — a receipt — and reads as one block.
  // Neutral grey and NO border, on purpose: on an order from two shops it sits
  // right under the shops' own blocks, which are near-white WITH a border, and
  // drawn the same way it read as a third shop.
  detail: {
    backgroundColor: COLORS.grayBg, borderRadius: 12,
    padding: 12, gap: 10,
  },
  detailItem:     { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  detailItemInfo: { flex: 1, minWidth: 0 },
  detailItemName: { fontSize: 13, fontWeight: '600', color: COLORS.textDark, lineHeight: 18 },
  // textBody, not textMedium, for the small print in the grey panel: the lighter
  // grey is 4.4:1 on it, just under what small text needs.
  detailItemMeta: { fontSize: 12, color: COLORS.textBody, marginTop: 2 },
  detailItemVal:  { fontSize: 13, fontWeight: '700', color: COLORS.textDark },
  // borderMedium inside the panel: the card's own hairline colour all but
  // disappears against the grey.
  detailRows:     { borderTopWidth: 1, borderTopColor: COLORS.borderMedium, paddingTop: 10, gap: 5 },

  // The one hairline on the card. The row has one height whichever buttons it
  // holds, so a card with "Cancel order" and one without end the same way. The
  // negative margin takes back part of the card's own padding: the buttons are
  // 44dp tall for the thumb, and their words would otherwise float well above
  // the bottom edge.
  actions: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    borderTopWidth: 1, borderTopColor: COLORS.border,
    paddingTop: 6, marginBottom: -6, minHeight: 54,
  },
  linkBtn:   { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingRight: 8 },
  linkTxt:   { fontSize: 14, fontWeight: '700', color: COLORS.primary },
  cancelBtn: {
    minHeight: 44, minWidth: 96, justifyContent: 'center', alignItems: 'center',
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.errorDark,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  // errorDark, not error: red500 on white is 3.8:1, and this is a word that has
  // to be read before it is pressed.
  cancelTxt: { fontSize: 14, fontWeight: '700', color: COLORS.errorDark },

  // errorDark: this is the weak-network message, read outdoors, and red500 on
  // the page background is 3.5:1.
  errorTxt:  { fontSize: 15, color: COLORS.errorDark, textAlign: 'center' },
  retryBtn:  { backgroundColor: COLORS.primary, borderRadius: 10, paddingHorizontal: 24, paddingVertical: 10, marginTop: 8 },
  retryTxt:  { color: COLORS.white, fontWeight: '700', fontSize: 15 },

  emptyTitle:    { fontSize: 18, fontWeight: '700', color: COLORS.gray700dark, marginTop: 12 },
  emptySubtitle: { fontSize: 14, color: COLORS.textMedium, textAlign: 'center', marginTop: 4 },
});
