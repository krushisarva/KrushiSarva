import { useRef, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Dimensions, Animated, StatusBar, TextInput, Linking,
} from 'react-native';
import PhotoIcon from '../../components/PhotoIcon';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { COLORS } from '@krushisarva/shared/constants/colors';
import { showPopup } from '../../utils/popup';


// `url` is the scheme's official government portal. Only schemes with ONE
// well-known official site carry it; the card shows no link button without it
// (KCC is applied for at banks, PKVY through the district office).
// The app knows nothing about a farmer's eligibility, so cards carry no
// "Eligible" status, and `benefit` names a rupee amount only where the scheme's
// own guidelines fix one (PM-KISAN, PKVY).
const SCHEMES = [
  {
    id: 1,
    name: 'PM-KISAN',
    code: 'PMKISAN',
    url: 'https://pmkisan.gov.in',
    fullName: 'Pradhan Mantri Kisan Samman Nidhi',
    benefit: '₹6,000/year',
    benefitType: 'Cash Transfer',
    icon: 'cash-outline',
    color: COLORS.primary,
    desc: 'Direct income support of ₹6,000/year to land-owning farmer families in 3 installments of ₹2,000.',
    eligibility: ['Family owns farm land (any size; some groups, such as income-tax payers, are excluded)', 'Valid Aadhaar', 'Registered bank account'],
    howToApply: 'Apply via PM-KISAN portal or nearest CSC centre.',
    deadline: 'Rolling — apply anytime',
  },
  {
    id: 2,
    name: 'PMFBY',
    code: 'PMFBY',
    url: 'https://pmfby.gov.in',
    fullName: 'Pradhan Mantri Fasal Bima Yojana',
    benefit: 'Low-premium crop insurance',
    benefitType: 'Crop Insurance',
    icon: 'shield-checkmark-outline',
    color: COLORS.blue,
    desc: 'Comprehensive crop insurance at low premium rates. Covers yield losses due to weather, pests & diseases.',
    eligibility: ['Cultivating notified crops', 'Premium: 2% for Kharif, 1.5% for Rabi'],
    howToApply: 'Apply via bank where Kisan Credit Card is held, or Common Service Centre.',
    deadline: 'Before sowing — check district office',
  },
  {
    id: 3,
    name: 'KCC',
    code: 'KCC',
    fullName: 'Kisan Credit Card',
    benefit: 'Low-interest crop loans',
    benefitType: 'Credit',
    icon: 'card-outline',
    color: COLORS.purple,
    desc: 'Short-term crop loans at 4% interest rate (after government subvention). Covers cultivation + household needs.',
    eligibility: ['Land holding owner/tenant', 'Age 18–75 years'],
    howToApply: 'Apply at nearest bank branch. Documents: Aadhaar, land records, passport photo.',
    deadline: 'Rolling — apply at any bank',
  },
  {
    id: 4,
    name: 'Soil Health Card',
    code: 'NMSA-SHC',
    url: 'https://soilhealth.dac.gov.in',
    fullName: 'Soil Health Card Scheme',
    benefit: 'Free soil testing',
    benefitType: 'Advisory',
    icon: 'earth-outline',
    color: COLORS.tangerine,
    desc: 'Free soil testing every 2 years with nutrient recommendations that help you apply the right amount of fertilizer.',
    eligibility: ['Any farmer with agricultural land'],
    howToApply: 'Visit nearest Krishi Vigyan Kendra or apply online at soilhealth.dac.gov.in',
    deadline: 'Rolling — check camp schedule',
  },
  {
    id: 5,
    name: 'PKVY',
    code: 'SMAM',
    fullName: 'Paramparagat Krishi Vikas Yojana',
    benefit: '₹50,000/hectare for 3 yrs',
    benefitType: 'Organic Farming',
    icon: 'leaf-outline',
    color: COLORS.primary,
    desc: 'Promotes organic farming through cluster-based approach. Covers certification, inputs, and marketing support.',
    eligibility: ['Cluster of 50 farmers', 'Minimum 50 acres contiguous land', 'Organic farming commitment'],
    howToApply: 'Form a cluster with neighbouring farmers. Apply via District Agriculture Office.',
    deadline: 'Check state agriculture dept',
  },
];

function SchemeCard({ scheme, onExpand, expanded, t }) {
  const heightAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(heightAnim, {
      toValue: expanded ? 1 : 0, duration: 300, useNativeDriver: false,
    }).start();
  }, [expanded]);

  return (
    <TouchableOpacity style={SC.card} onPress={onExpand} activeOpacity={0.85} accessibilityRole="button" accessibilityState={{ expanded }}>
      <View style={SC.cardTop}>
        <View style={[SC.iconWrap, { backgroundColor: `${scheme.color}15` }]}>
          <PhotoIcon
            set="scheme" name={scheme.code} size={40} radius={10}
            fallback={<Ionicons name={scheme.icon} size={20} color={scheme.color} />}
          />
        </View>
        <View style={{ flex: 1 }}>
          <View style={SC.nameRow}>
            <Text style={SC.name}>{scheme.name}</Text>
          </View>
          <Text style={SC.fullName} numberOfLines={1}>{scheme.fullName}</Text>
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.textMedium} />
      </View>

      <View style={SC.benefitRow}>
        <View style={SC.benefit}>
          <Text style={SC.benefitValue}>{scheme.benefit}</Text>
          <Text style={SC.benefitType}>{scheme.benefitType}</Text>
        </View>
      </View>

      {expanded && (
        <View style={SC.expandedBody}>
          <View style={SC.divider} />
          <Text style={SC.desc}>{scheme.desc}</Text>

          <Text style={SC.subLabel}>{t('scheme.eligibilitySection')}</Text>
          {scheme.eligibility.map((e, i) => (
            <View key={i} style={SC.listRow}>
              <View style={[SC.listDot, { backgroundColor: scheme.color }]} />
              <Text style={SC.listText}>{e}</Text>
            </View>
          ))}

          <Text style={SC.subLabel}>{t('scheme.howToApply')}</Text>
          <Text style={SC.applyText}>{scheme.howToApply}</Text>

          <View style={SC.deadlineRow}>
            <Ionicons name="calendar-outline" size={12} color={COLORS.grayMedium} />
            <Text style={SC.deadlineText}>{scheme.deadline}</Text>
          </View>

          {scheme.url ? (
            <TouchableOpacity
              style={[SC.applyBtn, { backgroundColor: scheme.color }]}
              // openURL rejects when no app can open the link; show the
              // address so the farmer can still reach the official portal.
              onPress={() => Linking.openURL(scheme.url).catch(() => showPopup(
                t('profile.linkFailedTitle', 'Could not open link'),
                t('govNotice.openFailed', { url: scheme.url, defaultValue: 'Open {{url}} in your phone browser.' }),
              ))}
              activeOpacity={0.85}
              accessibilityRole="link"
              accessibilityLabel={`${t('govNotice.officialWebsite', 'Official website')}: ${scheme.name}`}
            >
              <Text style={SC.applyBtnText}>{t('govNotice.officialWebsite', 'Official website')}</Text>
              <Ionicons name="open-outline" size={14} color={COLORS.white} />
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function SchemeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState('');

  const filtered = SCHEMES.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.fullName.toLowerCase().includes(search.toLowerCase()) ||
    s.benefitType.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <View style={SC.root}>
      <StatusBar barStyle="dark-content" />

      {/* ── Header ── */}
      <View style={[SC.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={SC.backBtn} accessibilityRole="button" accessibilityLabel={t('common.goBack', 'Go back')}>
          <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
        </TouchableOpacity>
        <View>
          <Text style={SC.headerTitle}>{t('scheme.title')}</Text>
          <Text style={SC.headerSub}>{t('scheme.subtitle')}</Text>
        </View>
        <View style={SC.countBadge} accessible>
          <Text style={SC.countValue}>{SCHEMES.length}</Text>
          <Text style={SC.countLabel}>{t('scheme.totalSchemes')}</Text>
        </View>
      </View>

      {/* ── Search ── */}
      <View style={SC.searchRow}>
        <Ionicons name="search-outline" size={16} color={COLORS.gray350} />
        <TextInput
          style={SC.searchInput}
          placeholder={t('scheme.searchPlaceholder')}
          placeholderTextColor={COLORS.gray350}
          value={search}
          onChangeText={setSearch}
          accessibilityLabel={t('scheme.searchPlaceholder', 'Search schemes...')}
        />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={SC.list}>
        {/* Play "government affiliation" rule: say plainly we are not a
            government app and point farmers at the official portals. */}
        <View style={SC.notice} accessible>
          <Ionicons name="information-circle-outline" size={16} color={COLORS.textMedium} />
          <Text style={SC.noticeText}>
            {t('govNotice.schemes', 'KrushiSarva is not affiliated with any government body. Scheme details here are short summaries and may be out of date; always confirm on the official government portal before applying.')}
          </Text>
        </View>

        {filtered.map(scheme => (
          <SchemeCard
            key={scheme.id}
            scheme={scheme}
            expanded={expanded === scheme.id}
            onExpand={() => setExpanded(expanded === scheme.id ? null : scheme.id)}
            t={t}
          />
        ))}

        {filtered.length === 0 && (
          <View style={SC.emptyState}>
            <Ionicons name="search" size={40} color={COLORS.textDark} />
            <Text style={SC.emptyText}>{t('scheme.noSchemesFound', { search })}</Text>
          </View>
        )}

        <TouchableOpacity style={SC.askBtn} onPress={() => navigation.navigate('AIChat', { initialMessage: 'Which government schemes am I eligible for?' })} activeOpacity={0.8} accessibilityRole="button">
          <Ionicons name="sparkles-outline" size={16} color={COLORS.white} />
          <Text style={SC.askBtnText}>{t('scheme.askAI')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const SC = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 18, paddingBottom: 12,
  },
  backBtn:      { width: 36, height: 36, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  headerTitle:  { fontSize: 18, fontWeight: '900', color: COLORS.slate800 },
  headerSub:    { fontSize: 10, color: COLORS.gray350, marginTop: 1 },
  countBadge:   { marginLeft: 'auto', alignItems: 'center' },
  countValue:   { fontSize: 22, fontWeight: '900', color: COLORS.primary, lineHeight: 24 },
  countLabel:   { fontSize: 10, color: COLORS.gray350 },

  // Search
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 18, marginBottom: 12,
    backgroundColor: COLORS.white,
    borderRadius: 12, paddingHorizontal: 14, height: 44,
    borderWidth: 1, borderColor: COLORS.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.slate800 },

  // Scheme card
  list: { paddingHorizontal: 18, paddingBottom: 48, gap: 10 },
  notice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: COLORS.white, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: COLORS.border,
  },
  noticeText: { flex: 1, fontSize: 12, color: COLORS.textMedium, lineHeight: 17 },
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 16, padding: 16, gap: 12,
    borderWidth: 1, borderColor: COLORS.border,
    shadowColor: COLORS.black, shadowOpacity: 0.04, shadowRadius: 6, elevation: 1,
  },
  cardTop:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconWrap:   { width: 42, height: 42, borderRadius: 12, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  nameRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name:       { fontSize: 15, fontWeight: '800', color: COLORS.slate800 },
  fullName:   { fontSize: 11, color: COLORS.gray350, marginTop: 2 },
  benefitRow: { flexDirection: 'row' },
  benefit:    {
    backgroundColor: COLORS.background, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
    gap: 2,
  },
  benefitValue:{ fontSize: 16, fontWeight: '900', color: COLORS.slate800 },
  benefitType: { fontSize: 10, color: COLORS.gray350, fontWeight: '600' },

  // Expanded
  expandedBody: { gap: 10 },
  divider:     { height: 1, backgroundColor: 'rgba(0,0,0,0.06)' },
  desc:        { fontSize: 13, color: COLORS.textMedium, lineHeight: 19 },
  subLabel:    { fontSize: 10, fontWeight: '800', color: COLORS.gray350, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4 },
  listRow:     { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  listDot:     { width: 6, height: 6, borderRadius: 3, marginTop: 6, flexShrink: 0 },
  listText:    { fontSize: 13, color: COLORS.textMedium, lineHeight: 19, flex: 1 },
  applyText:   { fontSize: 13, color: COLORS.textMedium, lineHeight: 19 },
  deadlineRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  deadlineText:{ fontSize: 11, color: COLORS.gray350 },
  applyBtn:    {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 10, paddingVertical: 11, marginTop: 4,
  },
  applyBtnText:{ fontSize: 13, fontWeight: '800', color: COLORS.white },

  // Empty
  emptyState: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  emptyText:  { fontSize: 14, color: COLORS.gray350, textAlign: 'center' },

  // Ask button
  askBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.primary, borderRadius: 16, paddingVertical: 15, marginTop: 8,
  },
  askBtnText: { fontSize: 14, fontWeight: '800', color: COLORS.white },
});
