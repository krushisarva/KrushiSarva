/**
 * AICreditsScreen — AI Credit Usage Dashboard
 *
 * Shows: balance left, used this month, and a Buy button.
 * Runs on a fixed monthly credit budget.
 */
import { COLORS, TYPE, SHADOWS } from '@krushisarva/shared/constants/colors';
import { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, Platform, RefreshControl, Alert, Modal, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { getAICredits } from '../../services/aiApi';
import AnimatedScreen from '@krushisarva/shared/components/ui/AnimatedScreen';
import { SkeletonBlock, SkeletonGroup } from '../../components/ui/Skeleton';
// The purchase flow — endpoints, sequencing and the sentence said at the end —
// lives beside this screen rather than in it, so the parts that decide what is
// SENT and what is SAID stay testable under the project's node Jest config.
import useCreditPurchase, { PACKS } from './components/CreditPurchase';
import CreditPackSheet from './components/CreditPackSheet';
import RazorpayCheckout from '../../components/payments/RazorpayCheckout';

// Fallback monthly allowance used only until the API returns the live value. The
// real budget is data.monthlyAllowance from the credit summary, so the bar tracks
// the admin-configured free grant + tier instead of a hardcoded constant.
const DEFAULT_MONTHLY_ALLOWANCE = 100;

export default function AICreditsScreen({ navigation }) {
  const { language, t } = useLanguage();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError]   = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const result = await getAICredits();
      setData(result);
      setLoadError(false);
    } catch {
      setLoadError(true);   // show a hint instead of silently rendering 0
    }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  // Reload whenever the screen regains focus, so an admin credit top-up appears the
  // moment the farmer opens or returns to this screen (no manual pull-to-refresh).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  /**
   * A purchase landed. Show the SERVER's balance.
   *
   * Deliberately not `balance + credited`: the server has already applied the
   * grant, any concurrent spend and — when the webhook got there first
   * (`alreadyProcessed`) — the credits this call did not itself add. Recomputing
   * it here would show a number that disagrees with the one the next refresh
   * fetches, on the single screen whose whole job is to be trusted about a
   * balance the farmer just paid for.
   */
  const handleCredited = useCallback(({ balance: newBalance }) => {
    if (newBalance == null) return;
    setData((prev) => ({ ...(prev || {}), balance: newBalance }));
  }, []);

  const purchase = useCreditPurchase({ onCredited: handleCredited });

  // The flow settles → ONE Alert.
  //
  // The effect depends on `notice` alone. usePaymentFlow returns a fresh object
  // literal every render, so `dismissNotice` — a useCallback closed over it —
  // has a new identity on every render too; listing it here would re-run this
  // effect on each one and stack a new Alert on the farmer's screen every time.
  // It is read through a ref instead, which is always current and never a
  // dependency.
  const { notice } = purchase;
  const dismissRef = useRef(purchase.dismissNotice);
  dismissRef.current = purchase.dismissNotice;
  const tRef = useRef(t);
  tRef.current = t;
  // Same reason: the "Try again" button reopens the picker through a ref.
  const openRef = useRef(purchase.openSheet);
  openRef.current = purchase.openSheet;

  useEffect(() => {
    if (!notice) return;
    const tr = tRef.current;
    const dismiss = () => dismissRef.current?.();
    // The server's own words win where it sent any — it knows things this app
    // does not, such as which pack went away.
    const body = notice.serverMessage
      || (notice.vars
        ? tr(notice.bodyKey, { ...notice.vars, defaultValue: notice.bodyFallback })
        : tr(notice.bodyKey, notice.bodyFallback));
    Alert.alert(
      tr(notice.titleKey, notice.titleFallback),
      body,
      // `mayRetry` is false for every outcome where the money may have moved,
      // so no "try again" is ever offered to someone who may already have paid.
      notice.mayRetry
        ? [
          { text: tr('cancel', 'Cancel'), style: 'cancel', onPress: dismiss },
          { text: tr('payments.retry', 'Try again'), onPress: () => { dismiss(); openRef.current?.(); } },
        ]
        : [{ text: tr('ok', 'OK'), onPress: dismiss }],
      { onDismiss: dismiss },
    );
  }, [notice]);

  // First load only. A focus re-fetch keeps the last known balance on screen
  // rather than blanking a number the farmer is already reading.
  if (loading && !data) {
    return (
      <AnimatedScreen style={S.root}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />

        <View style={S.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={S.backBtn}>
            <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={S.headerTitle}>{t('aiCredits.title')}</Text>
          </View>
        </View>

        {/* The gap lives on an inner view because SkeletonGroup's `style` sits
            on its outer wrapper, one level above these children. */}
        <SkeletonGroup label={t('loading', 'Loading...')} style={{ padding: 18 }}>
          <View style={{ gap: 14 }}>
            <View style={S.balanceCard}>
              <View style={S.balanceRow}>
                <View style={{ gap: 8 }}>
                  <SkeletonBlock w={92} h={12} />
                  <SkeletonBlock w={120} h={40} r={8} />
                </View>
                <View style={{ gap: 8, alignItems: 'flex-end' }}>
                  <SkeletonBlock w={52} h={20} r={6} />
                  <SkeletonBlock w={96} h={11} />
                </View>
              </View>
              <View style={S.barWrap}><SkeletonBlock w="100%" h={8} r={4} /></View>
              <View style={S.barLabels}>
                <SkeletonBlock w={88} h={10} />
                <SkeletonBlock w={88} h={10} />
              </View>
            </View>
            <SkeletonBlock w="100%" h={50} r={16} />
          </View>
        </SkeletonGroup>
      </AnimatedScreen>
    );
  }

  const balance = data?.balance ?? 0;
  const budget  = Number(data?.monthlyAllowance) > 0 ? Number(data.monthlyAllowance) : DEFAULT_MONTHLY_ALLOWANCE;
  const used    = Math.max(0, budget - balance);
  const usedPct = Math.min(100, Math.round((used / budget) * 100));

  const packsLoading = purchase.packsState === PACKS.LOADING;

  /**
   * Open the pack picker — or, while the gateway is off or the catalogue never
   * arrived, say so.
   *
   * `packsState` is UNAVAILABLE whenever online payment is disabled server-side,
   * the publishable key is missing, or GET /ai/credits/packs failed. All three
   * keep the pre-existing "not available yet" message rather than opening an
   * empty sheet or a checkout the server cannot honour.
   */
  const handleBuy = () => {
    if (purchase.packsState === PACKS.READY) { purchase.openSheet(); return; }
    Alert.alert(
      t('aiCredits.buyCredits', 'Buy Credits'),
      t('aiCredits.buySoon', 'Purchasing will be available soon.'),
    );
  };

  return (
    <AnimatedScreen style={S.root}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />

      {/* Header */}
      <View style={S.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={S.backBtn}>
          <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.headerTitle}>{t('aiCredits.title')}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={S.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} colors={[COLORS.primary]} />}
      >

        {loadError && (
          <View style={S.errorBanner}>
            <Ionicons name="cloud-offline-outline" size={16} color={COLORS.amberDark || COLORS.amber} />
            <Text style={S.errorBannerText}>
              {t('aiCredits.loadError', "Couldn't load your latest balance. Pull down to refresh.")}
            </Text>
          </View>
        )}

        {/* Balance card */}
        <View style={S.balanceCard}>
          <View style={S.balanceRow}>
            <View>
              <Text style={S.balanceLabel}>{t('aiCredits.balanceLeft', 'Balance left')}</Text>
              <Text style={S.balanceValue}>{balance}</Text>
            </View>
            <View style={S.usedBox}>
              <Text style={S.usedValue}>{used}</Text>
              <Text style={S.usedLabel}>{t('aiCredits.usedThisMonth', 'Used this month')}</Text>
            </View>
          </View>

          {/* Usage bar */}
          <View style={S.barWrap}>
            <View style={[S.barFill, { width: `${usedPct}%`, backgroundColor: COLORS.amber }]} />
          </View>
          <View style={S.barLabels}>
            <Text style={S.barLabel}>{used} {t('aiCredits.usedThisMonth', 'Used this month')}</Text>
            <Text style={S.barLabel}>{budget} {t('aiCredits.monthlyBudget', 'Monthly budget')}</Text>
          </View>
        </View>

        {/* Buy button.
            Disabled while the catalogue is still loading — a tap in that window
            would otherwise fire the "not available yet" message at a farmer for
            whom it is perfectly available, half a second early. Also disabled
            for the length of a payment, so the picker cannot be reopened on top
            of a checkout that is already running. */}
        <TouchableOpacity
          style={[S.buyBtn, (packsLoading || purchase.busy) && S.buyBtnDim]}
          activeOpacity={0.85}
          onPress={handleBuy}
          disabled={packsLoading || purchase.busy}
        >
          {packsLoading || purchase.busy
            ? <ActivityIndicator size="small" color={COLORS.white} />
            : <Ionicons name="flash" size={16} color={COLORS.white} />}
          <Text style={S.buyBtnText}>{t('aiCredits.buyCredits', 'Buy Credits')}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── The purchase ────────────────────────────────────────────────────
          Pick a pack → the server mints a gateway order for THAT pack id →
          the sheet below opens on the order id alone. No price crosses the
          wire from this app in either direction (§51). */}
      <CreditPackSheet
        // Presented only while nothing else is. React Native gives each Modal
        // its own Android window, and stacking three of them (picker, checkout,
        // verifying overlay) is a reliable way to get a black or unresponsive
        // window on the low-end devices this app targets (§40). The picker stays
        // up through `initiating` — that is where the row spinner lives and the
        // farmer needs the feedback — and steps aside once the gateway takes
        // over. `sheetOpen` itself is untouched, so the hook still closes it on
        // settle and a cancelled checkout does not strand a hidden sheet.
        visible={purchase.sheetOpen
          && !purchase.checkoutProps.visible
          && !purchase.verifying}
        packs={purchase.packs}
        busy={purchase.busy}
        selectedPackId={purchase.selectedPack?.id ?? null}
        onSelect={purchase.buy}
        onClose={purchase.closeSheet}
      />

      {/* Opened only with a server-minted order id, which already carries the
          amount; the signature it returns is re-verified against the secret key
          on /ai/credits/purchase/confirm. `onDismiss` does NOT mean failure —
          usePaymentFlow asks the server what actually happened. */}
      <RazorpayCheckout
        {...purchase.checkoutProps}
        keyId={purchase.keyId}
        // What the farmer is paying for, in the gateway sheet's own header.
        // Built from the SERVER's pack, so it cannot describe one pack while
        // the order charges for another.
        description={purchase.selectedPack
          ? `${purchase.selectedPack.credits} ${t('aiCredits.credits', 'credits')} · KrushiSarva`
          : undefined}
      />

      {/* Blocking overlay while the server is asked. The farmer must not be able
          to start a second payment during this window — and when they got here
          by closing the sheet, the wording says we are CHECKING, never that
          anything failed. */}
      {purchase.verifying ? (
        <Modal visible transparent animationType="fade">
          <View style={S.verifyBackdrop}>
            <View style={S.verifyCard}>
              <ActivityIndicator size="large" color={COLORS.primary} />
              <Text style={S.verifyTitle}>
                {purchase.verifyReason === 'dismiss'
                  ? t('payments.dismissedCheck', 'Checking whether your payment went through…')
                  : t('payments.verifying', 'Confirming your payment')}
              </Text>
              <Text style={S.verifyBody}>
                {t('payments.doNotClose', 'Please do not close the app or pay again.')}
              </Text>
            </View>
          </View>
        </Modal>
      ) : null}
    </AnimatedScreen>
  );
}

const S = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  scroll: { padding: 18, gap: 14 },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingTop: Platform.OS === 'ios' ? 56 : 16, paddingHorizontal: 18, paddingBottom: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, ...SHADOWS.small,
  },
  backBtn: { width: 36, height: 36, justifyContent: 'center', alignItems: 'center', borderRadius: 10, backgroundColor: COLORS.primaryPale },
  headerTitle: { fontSize: 20, fontWeight: '900', color: COLORS.textDark },

  // Balance card
  balanceCard: {
    backgroundColor: COLORS.surface, borderRadius: 20, padding: 20,
    borderWidth: 1, borderColor: '#FFE082', ...SHADOWS.small,
  },
  balanceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  balanceLabel: { fontSize: 12, color: COLORS.textMedium, fontWeight: '600' },
  balanceValue: { fontSize: 44, fontWeight: '900', color: COLORS.amber, lineHeight: 48 },
  usedBox: { alignItems: 'flex-end' },
  usedValue: { fontSize: 22, fontWeight: '900', color: COLORS.textDark },
  usedLabel: { fontSize: 11, color: COLORS.textLight, fontWeight: '600', marginTop: 2 },

  barWrap: { height: 8, backgroundColor: '#FFF3E0', borderRadius: 4, overflow: 'hidden', marginBottom: 6 },
  barFill: { height: 8, borderRadius: 4 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  barLabel: { fontSize: 10, color: COLORS.textLight, fontWeight: '600' },

  // Buy button
  buyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.amber, borderRadius: 16, paddingVertical: 16, ...SHADOWS.small,
  },
  buyBtnText: { fontSize: 15, fontWeight: '900', color: COLORS.white },
  buyBtnDim: { opacity: 0.6 },

  // Verifying overlay — same shape as the shop checkout's, so the two payment
  // screens do not teach a farmer two different "wait" states.
  verifyBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },
  verifyCard: {
    backgroundColor: COLORS.surface, borderRadius: 16, padding: 28,
    alignItems: 'center', gap: 12, marginHorizontal: 40,
  },
  verifyTitle: { fontSize: 15, fontWeight: '700', color: COLORS.textDark, textAlign: 'center' },
  verifyBody: { fontSize: 12, fontWeight: '600', color: COLORS.textMedium, textAlign: 'center' },

  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#FFF3E0', borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: '#FFE082',
  },
  errorBannerText: { flex: 1, fontSize: 12, color: COLORS.textMedium, fontWeight: '600' },
});
