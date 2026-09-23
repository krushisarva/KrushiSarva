/**
 * The pack picker — presentation only.
 *
 * Every figure on screen comes from the `packs` prop, which comes from
 * GET /ai/credits/packs. There is deliberately no fallback pack list, no
 * "popular" default and no local price: a price rendered from a constant is a
 * price that will one day disagree with what the farmer is actually charged
 * (CLAUDE.md §51). If the server sent nothing, this sheet shows nothing.
 *
 * ── Why a plain map and not a FlatList ───────────────────────────────────────
 * §41 says virtualise LARGE lists. The server ships a frozen catalogue of four
 * packs; a FlatList here would add a VirtualizedList, a cell renderer and a
 * windowing pass to render four rows, which costs a low-end device more than it
 * saves. The ScrollView is there so a fifth pack — or a small screen in a large
 * font setting — still reaches the bottom row.
 */
import { View, Text, StyleSheet, Modal, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SHADOWS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
// The shop's rupee formatter. Imported rather than copied — paymentClient.js
// already reaches into shopUtils for the same reason: one money-formatting
// rule, not one per feature.
import { inr } from '../../AgriStore/shopUtils';

export default function CreditPackSheet({
  visible, packs, busy, selectedPackId, onSelect, onClose,
}) {
  const { t } = useLanguage();

  return (
    <Modal
      visible={!!visible}
      transparent
      animationType="slide"
      // Android back button: the same exit as the X, and just as blocked while
      // a payment is being raised — `onClose` is the hook's guarded closeSheet.
      onRequestClose={onClose}
    >
      <View style={S.backdrop}>
        {/* Tapping the dimmed area closes the sheet, the usual bottom-sheet
            gesture. It goes through the same guarded onClose, so it cannot
            close a sheet whose payment is already in flight. */}
        <TouchableOpacity style={S.backdropTap} activeOpacity={1} onPress={onClose} />

        <View style={S.sheet}>
          <View style={S.grabber} />

          <View style={S.head}>
            <View style={{ flex: 1 }}>
              <Text style={S.title}>{t('aiCredits.buyCredits', 'Buy Credits')}</Text>
              <Text style={S.sub}>
                {t('aiCredits.pickPack', 'Choose a pack. Credits never expire.')}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              disabled={busy}
              style={S.closeBtn}
              accessibilityRole="button"
              accessibilityLabel={t('close', 'Close')}
            >
              <Ionicons name="close" size={20} color={busy ? COLORS.textLight : COLORS.textDark} />
            </TouchableOpacity>
          </View>

          <ScrollView style={S.list} contentContainerStyle={{ gap: 10, paddingBottom: 6 }}>
            {packs.map((pack) => {
              // Only the tapped row spins. Every row is disabled while any
              // payment is in flight, so a farmer cannot start a second
              // purchase on top of the first.
              const isSelected = busy && pack.id === selectedPackId;
              return (
                <TouchableOpacity
                  key={pack.id}
                  style={[S.row, isSelected && S.rowActive, busy && !isSelected && S.rowDim]}
                  activeOpacity={0.85}
                  disabled={busy}
                  onPress={() => onSelect(pack.id)}
                  accessibilityRole="button"
                >
                  <View style={S.rowIcon}>
                    <Ionicons name="flash" size={18} color={COLORS.amber} />
                  </View>
                  <View style={{ flex: 1 }}>
                    {/* The server's own wording where it sent one; otherwise a
                        translated "<n> credits" — never an invented name. */}
                    <Text style={S.rowLabel}>
                      {pack.label || `${pack.credits} ${t('aiCredits.credits', 'credits')}`}
                    </Text>
                    <Text style={S.rowCredits}>
                      {pack.credits} {t('aiCredits.credits', 'credits')}
                    </Text>
                  </View>
                  {isSelected
                    ? <ActivityIndicator size="small" color={COLORS.primary} />
                    : <Text style={S.rowPrice}>{inr(pack.priceInr)}</Text>}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={S.foot}>
            <Ionicons name="shield-checkmark-outline" size={14} color={COLORS.textLight} />
            <Text style={S.footText}>
              {t('payments.secureNote', 'Payment is processed securely. Do not close the app while paying.')}
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const S = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: 22,
    maxHeight: '80%', ...SHADOWS.small,
  },
  grabber: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.border,
    alignSelf: 'center', marginBottom: 12,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
  title: { fontSize: 18, fontWeight: '900', color: COLORS.textDark },
  sub: { fontSize: 12, color: COLORS.textMedium, fontWeight: '600', marginTop: 2 },
  closeBtn: {
    width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.background,
  },

  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: COLORS.background, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: COLORS.border,
  },
  rowActive: { borderColor: COLORS.amber, backgroundColor: '#FFF8E1' },
  rowDim: { opacity: 0.5 },
  rowIcon: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: '#FFF3E0',
    alignItems: 'center', justifyContent: 'center',
  },
  rowLabel: { fontSize: 15, fontWeight: '800', color: COLORS.textDark },
  rowCredits: { fontSize: 11, color: COLORS.textLight, fontWeight: '600', marginTop: 2 },
  rowPrice: { fontSize: 16, fontWeight: '900', color: COLORS.primary },

  foot: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 },
  footText: { flex: 1, fontSize: 11, color: COLORS.textLight, fontWeight: '600' },
});
