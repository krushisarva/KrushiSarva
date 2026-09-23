/**
 * LabourDetail — Worker/group profile.
 * Shows: photo gallery, skills, experience, languages, pricing, location.
 * Actions: call the provider, or book them for a date range.
 *
 * ── Why there is a booking form here now ─────────────────────────────────────
 * This screen was call-only, and the backend has always accepted a labour
 * booking (`POST /rent/bookings` with `labourListingId`, priced
 * pricePerDay × days × workerCount). With advance payment arriving for rent,
 * "ring them and sort it out yourself" is no longer the whole product: there
 * has to be a booking for a payment to belong to. The form is deliberately the
 * smallest one that can produce a valid request — range, how many workers, a
 * note — and the Call button is untouched, because for a lot of providers a
 * phone call is still how the job actually gets agreed.
 *
 * The flow itself is not here: `useRentBooking` decides paid-vs-free and
 * `rentBookingFlow` decides what is said, both shared with MachineryDetail.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Image, ActivityIndicator, Dimensions, StatusBar, Alert, Modal,
} from 'react-native';
import { safeOpenURL, sanitizePhone } from '../../utils/sanitize';
import useContactReveal from '../../hooks/useContactReveal';
import { fs } from '../../utils/responsive';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import api from '@krushisarva/shared/services/api';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { useAuth } from '@krushisarva/shared/context/AuthContext';
import { COLORS } from '@krushisarva/shared/constants/colors';
import AnimatedScreen from '@krushisarva/shared/components/ui/AnimatedScreen';
import { SkeletonDetail } from '../../components/ui/Skeleton';
import RentAvailabilityPicker from '../../components/ui/RentAvailabilityPicker';
import RazorpayCheckout from '../../components/payments/RazorpayCheckout';
import { invalidateFocusData } from '../../hooks/useFocusRefresh';
import useRentBooking from './components/useRentBooking';
import { noticeText } from './components/rentBookingFlow';
import { inr } from '../AgriStore/shopUtils';

const { width: W } = Dimensions.get('window');

// Section header with a small accent bar for visual rhythm.
function SectionTitle({ children }) {
  return (
    <View style={D.sectionTitleRow}>
      <View style={D.sectionAccent} />
      <Text style={D.sectionTitle}>{children}</Text>
    </View>
  );
}

// Labelled detail row (icon chip + label + value) for the Worker Details card.
function DetailRow({ icon, label, value, color = COLORS.primary }) {
  if (!value) return null;
  return (
    <View style={D.detailRow}>
      <View style={[D.detailIcon, { backgroundColor: color + '18' }]}>
        <Ionicons name={icon} size={16} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={D.detailLabel}>{label}</Text>
        <Text style={D.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

// Gallery image slide with a graceful fallback. A valid-but-unreachable URL
// makes RN's <Image> render a blank box with no recovery — onError swaps in a
// gradient + worker initials so the slide is never a silent white screen.
function GalleryImage({ uri, initials }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <LinearGradient
        colors={[COLORS.primary, COLORS.greenDeep]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={[D.galImg, { height: 280, justifyContent: 'center', alignItems: 'center' }]}
      >
        <View style={D.bigAvatar}>
          <Text style={D.bigAvatarTxt}>{initials}</Text>
        </View>
      </LinearGradient>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={[D.galImg, { height: 280 }]}
      resizeMode="cover"
      onError={() => setFailed(true)}
    />
  );
}

export default function LabourDetail({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuth();
  const { id, labour: passedData } = route.params;

  // Reveal-then-dial: the provider's number is fetched from an authenticated,
  // rate-limited, audited endpoint at the moment the farmer taps Call, rather
  // than being shipped to every browser of the listing.
  const { call: callProvider, revealing, phone: revealedPhone } = useContactReveal(
    id ? `/rent/labour/${id}/contact` : null,
    { t, signedIn: !!user },
  );

  const [data,        setData]        = useState(passedData || null);
  const [galIdx,      setGalIdx]      = useState(0);
  const [loadingData, setLoadingData] = useState(!passedData);

  // ── Booking form ────────────────────────────────────────────────────────────
  const [bookFrom,    setBookFrom]    = useState(null);   // 'YYYY-MM-DD'
  const [bookTo,      setBookTo]      = useState(null);
  const [workerCount, setWorkerCount] = useState(1);
  const [notes,       setNotes]       = useState('');
  // { start, end, days, amount, paid, paidAmount } | null
  const [bookingDone, setBookingDone] = useState(null);

  const listingId = id || passedData?.id;

  const aliveRef   = useRef(true);
  // Same guard, and the same reasoning, as MachineryDetail's: released only by
  // a terminal outcome, so the button stays disarmed for the whole
  // initiate → payment sheet → confirm window rather than re-arming the moment
  // `book()` returns and letting a second tap raise a second gateway order.
  const bookingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!listingId) return;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await api.get(`/rent/labour/${listingId}`, { signal: ac.signal });
        if (!ac.signal.aborted) setData(res.data.data);
      } catch { /* keep passedData */ }
      finally { if (!ac.signal.aborted) setLoadingData(false); }
    })();
    return () => ac.abort();
  }, [listingId]);

  const bookedDays = (() => {
    if (!bookFrom || !bookTo) return 0;
    const s = new Date(bookFrom), e = new Date(bookTo);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
    return Math.round((e - s) / 86400000) + 1;
  })();
  // Mirrors the server's own arithmetic (rent.routes.js: pricePerDay × days ×
  // workerCount) so the card shows what the booking will cost. It is a PREVIEW,
  // never an input — no total is sent on either path.
  const bookedTotal = bookedDays > 0
    ? bookedDays * (Number(data?.pricePerDay) || 0) * Math.max(1, workerCount)
    : 0;

  const rentBooking = useRentBooking({
    type: 'labour',

    onBooked: ({ booking: created, paid, amount, request }) => {
      bookingRef.current = false;
      if (!aliveRef.current) return;
      const bDays = Number(request?.days) || 0;
      setBookFrom(null); setBookTo(null); setNotes('');
      setBookingDone({
        start: request?.startDate ?? null,
        end:   request?.endDate   ?? null,
        days:  bDays,
        amount: Number(created?.totalAmount)
          || (bDays * (Number(data?.pricePerDay) || 0) * Math.max(1, Number(request?.workerCount) || 1)),
        paid: !!paid,
        paidAmount: paid ? amount : null,
      });
      invalidateFocusData('rent');
    },

    onNotice: (notice) => {
      bookingRef.current = false;
      if (!aliveRef.current) return;
      const { title, body } = noticeText(notice, t, inr);
      Alert.alert(title, body);
      if (notice?.kind === 'SLOT_GONE' || notice?.kind === 'SLOT_TAKEN') {
        setBookFrom(null); setBookTo(null);
      }
      if (notice?.moneyTaken) invalidateFocusData('rent');
    },
  });

  const handleBook = useCallback(async () => {
    if (!bookFrom || !bookTo) {
      Alert.alert(t('rent.selectDatesAlert'), t('rent.selectDatesMsg'));
      return;
    }
    if (bookedDays <= 0) {
      Alert.alert(t('rent.invalidRange'), t('rent.invalidRangeMsg'));
      return;
    }
    if (bookingRef.current) return;
    bookingRef.current = true;

    // `workerCount` is a HEAD COUNT, not money: the server multiplies its own
    // rate by it. Nothing resembling a total is on the wire (claude.md §51).
    const outcome = await rentBooking.book({
      listingId: listingId,
      startDate: bookFrom,
      endDate:   bookTo,
      days:      bookedDays,
      workerCount,
      notes,
    });
    if (outcome?.skipped) bookingRef.current = false;
  }, [bookFrom, bookTo, bookedDays, workerCount, notes, listingId, rentBooking, t]);

  if (loadingData || !data) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.white }}>
        {/* heroH matches the 280pt gallery / avatar header below. */}
        <SkeletonDetail heroH={280} label={t('loading')} />
      </View>
    );
  }

  const l = data;
  // How many workers this listing can actually supply. `groupSize` is 1 for a
  // lone worker, in which case the stepper is not rendered at all.
  const maxWorkers = Math.max(1, Number(l.groupSize) || 1);
  // A provider viewing their own worker listing can't hire themselves — show
  // owner controls (Edit) instead of the Call/Hire actions.
  const isOwner = !!user && (user.id === l.provider?.id || user.id === l.providerId);
  // The number is fetched on demand rather than shipped with the listing —
  // see useContactReveal. `phone` is null until the farmer actually taps Call,
  // so the button no longer advertises a stranger's number on screen.
  const phone = revealedPhone;
  const allMedia = [
    ...(l.image  ? [l.image]    : []),
    ...(l.images || []),
    ...(l.videos || []),
  ];
  const initials = (l.leader || l.name || 'W').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  // Availability is two facts that used to be rendered independently and could
  // contradict each other: the provider's `available` toggle, and the date
  // window. A listing whose window had already closed still showed a green
  // "Available" badge. Resolve them into one state and drive both the badge and
  // the window card from it.
  //   'open'     — available now (no window, or today falls inside it)
  //   'upcoming' — window starts in the future
  //   'ended'    — window closed
  //   'busy'     — provider toggled themselves off
  const avail = (() => {
    const from = l.availableFrom ? new Date(l.availableFrom) : null;
    const to   = l.availableTo   ? new Date(l.availableTo)   : null;
    // Compare on date, not timestamp: a window ending "today" is still open.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (to && to < today) return 'ended';
    if (!l.available) return 'busy';
    if (from && from > today) return 'upcoming';
    return 'open';
  })();

  const AVAIL_UI = {
    open:     { bg: COLORS.primaryPale, fg: COLORS.primary,   label: t('rent.listAvailable') },
    upcoming: { bg: COLORS.yellowAmber, fg: COLORS.amber,     label: t('rent.listAvailable') },
    busy:     { bg: COLORS.orangeWarm,  fg: COLORS.cta,       label: t('rent.busy') },
    ended:    { bg: COLORS.lightGray2,  fg: COLORS.grayMid2,  label: t('rent.busy') },
  }[avail];

  // DD/MM/YYYY built by hand. `toLocaleDateString('en-IN')` was hardcoded to one
  // locale in a 10-language app, and Hermes ships without full ICU, so passing
  // the user's locale instead would silently fall back (or throw) on device.
  const fmtDate = (d) => {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  };

  // reveal-then-dial; the hook alerts on failure and caches the number.
  const handleCall = callProvider;

  return (
    <AnimatedScreen>
    <View style={D.root}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 110 }}>

        {/* ── Gallery ── */}
        {allMedia.length > 0 ? (
          <View style={{ height: 280, position: 'relative' }}>
            <ScrollView
              horizontal pagingEnabled showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={e => setGalIdx(Math.round(e.nativeEvent.contentOffset.x / W))}
            >
              {allMedia.map((uri, i) => {
                const isVideo = l.videos?.includes(uri);
                return (
                  <View key={i} style={{ width: W, height: 280 }}>
                    {isVideo
                      ? <Video
                          source={{ uri }}
                          style={[D.galImg, { height: 280 }]}
                          resizeMode={ResizeMode.COVER}
                          useNativeControls
                          shouldPlay={false}
                          isLooping={false}
                        />
                      : <GalleryImage uri={uri} initials={initials} />
                    }
                  </View>
                );
              })}
            </ScrollView>
            {/* Gradient overlay */}
            <LinearGradient
              colors={['rgba(0,0,0,0.35)', 'transparent', 'rgba(0,0,0,0.45)']}
              locations={[0, 0.45, 1]}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              pointerEvents="none"
            />
            {/* Back only. The sticky bottom bar is always on screen — including
                at scroll-top — so a third call button here was redundant and sat
                a thumb's width from Back. */}
            <View style={[D.galleryNav, { paddingTop: insets.top + 8 }]}>
              <TouchableOpacity onPress={() => navigation.goBack()} style={D.navBtn}>
                <Ionicons name="arrow-back" size={22} color={COLORS.white} />
              </TouchableOpacity>
            </View>
            {allMedia.length > 1 && (
              <View style={D.dots}>
                {allMedia.map((_, i) => <View key={i} style={[D.dot, i === galIdx && D.dotActive]} />)}
              </View>
            )}
          </View>
        ) : (
          <LinearGradient
            colors={[COLORS.primary, COLORS.greenDeep]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            // Unlike the gallery path there is no photo to bleed under the
            // status bar, so the avatar must start BELOW the notch and the nav
            // row. A static paddingTop put its top edge under the status bar on
            // any device with a non-zero top inset.
            style={[D.avatarHero, { paddingTop: insets.top + 56 }]}
          >
            {/* Back button for no-media path */}
            <View style={[D.galleryNav, { paddingTop: insets.top + 8 }]}>
              <TouchableOpacity onPress={() => navigation.goBack()} style={D.navBtn}>
                <Ionicons name="arrow-back" size={22} color={COLORS.white} />
              </TouchableOpacity>
            </View>
            <View style={D.bigAvatar}>
              <Text style={D.bigAvatarTxt}>{initials}</Text>
            </View>
          </LinearGradient>
        )}

        <View style={D.content}>

          {/* ── Name + Availability ── */}
          <View style={D.nameRow}>
            <View style={{ flex: 1 }}>
              <Text style={D.name}>{l.leader || l.name}</Text>
              {l.name && l.leader && <Text style={D.groupName}>{l.name}</Text>}
              {l.groupSize > 1 && (
                <View style={D.groupBadge}>
                  <Ionicons name="people" size={13} color={COLORS.primary} />
                  <Text style={D.groupBadgeTxt}>{t('rent.workersAvailable', { count: l.groupSize })}</Text>
                </View>
              )}
            </View>
            <View style={[D.availBadge, { backgroundColor: AVAIL_UI.bg }]}>
              <View style={[D.availDot, { backgroundColor: AVAIL_UI.fg }]} />
              <Text style={[D.availTxt, { color: AVAIL_UI.fg }]}>{AVAIL_UI.label}</Text>
            </View>
          </View>

          {/* ── Pricing ── */}
          <View style={D.priceRow}>
            <View style={D.priceCard}>
              <Text style={D.priceAmt}>₹{l.pricePerDay?.toLocaleString()}</Text>
              <Text style={D.priceLbl}>{t('rent.perDayShort')}</Text>
            </View>
            {l.pricePerHour ? (
              <View style={[D.priceCard, { backgroundColor: COLORS.lavenderPale }]}>
                <Text style={[D.priceAmt, { color: COLORS.purpleDark }]}>₹{l.pricePerHour?.toLocaleString()}</Text>
                <Text style={D.priceLbl}>{t('rent.perHourShort')}</Text>
              </View>
            ) : null}
            {l.rating > 0 && (
              <View style={D.ratingCard}>
                <View style={{ flexDirection: 'row', gap: 2 }}>
                  {[1,2,3,4,5].map(s => (
                    <Ionicons key={s} name={s <= Math.round(l.rating) ? 'star' : 'star-outline'} size={12} color={COLORS.yellowDark2} />
                  ))}
                </View>
                <Text style={D.ratingTxt}>{l.rating?.toFixed(1)} ({l.ratingCount})</Text>
              </View>
            )}
          </View>

          {/* ── Owner notice / Call CTA Card ── */}
          {isOwner ? (
            <View style={D.ownerNotice}>
              <Ionicons name="information-circle" size={22} color={COLORS.primary} />
              <Text style={D.ownerNoticeTxt}>
                {t('rent.ownListingMsg', "This is your own listing — you can't hire it.")}
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[D.callCard, !phone && { opacity: 0.4 }]}
              onPress={handleCall}
              disabled={revealing}
              activeOpacity={0.85}
            >
              <View style={D.callCardIcon}>
                <Ionicons name="call" size={26} color={COLORS.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={D.callCardTitle}>{t('rent.callToHire')}</Text>
                <Text style={D.callCardSub}>
                  {revealing ? t('loading') : phone || t('rent.tapToSeeNumber', 'Tap to see the number')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={COLORS.primary} />
            </TouchableOpacity>
          )}

          {/* ── Book this worker ── */}
          {!isOwner && (
            <View style={D.bookCard}>
              <View style={D.bookHead}>
                <Ionicons name="calendar-outline" size={16} color={COLORS.primary} />
                <Text style={D.bookTitle}>{t('rent.bookWorker', 'Book this worker')}</Text>
              </View>

              <RentAvailabilityPicker
                from={bookFrom}
                to={bookTo}
                onChange={({ from, to }) => { setBookFrom(from); setBookTo(to); }}
                t={t}
              />

              {/* Head count. Capped at the group size the provider listed — a
                  request for more workers than exist is a booking the provider
                  can only reject. */}
              {maxWorkers > 1 && (
                <View style={D.wcRow}>
                  <Text style={D.wcLabel}>{t('rent.workersNeeded', 'Workers needed')}</Text>
                  <View style={D.wcStepper}>
                    <TouchableOpacity
                      style={[D.wcBtn, workerCount <= 1 && { opacity: 0.35 }]}
                      onPress={() => setWorkerCount((n) => Math.max(1, n - 1))}
                      disabled={workerCount <= 1}
                      accessibilityRole="button"
                      accessibilityLabel={t('rent.fewerWorkers', 'Fewer workers')}
                    >
                      <Ionicons name="remove" size={18} color={COLORS.primary} />
                    </TouchableOpacity>
                    <Text style={D.wcValue}>{workerCount}</Text>
                    <TouchableOpacity
                      style={[D.wcBtn, workerCount >= maxWorkers && { opacity: 0.35 }]}
                      onPress={() => setWorkerCount((n) => Math.min(maxWorkers, n + 1))}
                      disabled={workerCount >= maxWorkers}
                      accessibilityRole="button"
                      accessibilityLabel={t('rent.moreWorkers', 'More workers')}
                    >
                      <Ionicons name="add" size={18} color={COLORS.primary} />
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {bookedDays > 0 ? (
                <>
                  <View style={D.bookTotalRow}>
                    <Text style={D.bookTotalLbl}>
                      {bookedDays} {t('rent.day')}
                      {workerCount > 1 ? ` × ${workerCount}` : ''} × ₹{Number(data.pricePerDay || 0).toLocaleString()}
                    </Text>
                    <Text style={D.bookTotalAmt}>{inr(bookedTotal)}</Text>
                  </View>
                  <TextInput
                    style={D.bookNotes}
                    placeholder={t('rent.notesPlaceholder')}
                    placeholderTextColor={COLORS.grayLightMid}
                    value={notes}
                    onChangeText={setNotes}
                    multiline
                    numberOfLines={2}
                  />
                </>
              ) : null}

              <TouchableOpacity
                style={[D.bookBtn, (bookedDays <= 0 || rentBooking.busy) && { opacity: 0.5 }]}
                onPress={handleBook}
                disabled={bookedDays <= 0 || rentBooking.busy}
                activeOpacity={0.85}
                accessibilityRole="button"
              >
                {rentBooking.busy
                  ? <ActivityIndicator size="small" color={COLORS.white} />
                  : <>
                      <Ionicons name={rentBooking.payOnline ? 'card' : 'calendar'} size={18} color={COLORS.white} />
                      {/* No rupee figure on the paid button: the server decides
                          the advance and only says so in its initiate reply, so a
                          number here would be the full amount pretending to be
                          what is about to be charged. */}
                      <Text style={D.bookBtnTxt} numberOfLines={1}>
                        {bookedDays <= 0
                          ? t('rent.selectDatesPlaceholder')
                          : rentBooking.payOnline
                            ? `${t('rent.payAndBook', 'Pay & book')} · ${bookedDays}d`
                            : `${t('rent.booking')} ${bookedDays}d — ${inr(bookedTotal)}`}
                      </Text>
                    </>
                }
              </TouchableOpacity>
            </View>
          )}

          {/* ── Skills ── */}
          {(l.skills || []).length > 0 && (
            <>
              <SectionTitle>{t('rent.skillsExpertise')}</SectionTitle>
              <View style={D.skillsWrap}>
                {l.skills.map((s, i) => (
                  <View key={i} style={D.skillChip}>
                    <Ionicons name="checkmark-circle" size={14} color={COLORS.primary} />
                    <Text style={D.skillTxt}>{s}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* ── Worker details (experience, languages, location) ── */}
          {(l.experience || l.languages?.length > 0 || l.location) ? (
            <>
              <SectionTitle>{t('rent.workerDetails', 'Worker Details')}</SectionTitle>
              <View style={D.detailCard}>
                <DetailRow
                  icon="ribbon-outline"
                  label={t('rent.experienceLabel', 'Experience')}
                  value={l.experience}
                  color={COLORS.primary}
                />
                <DetailRow
                  icon="chatbubbles-outline"
                  label={t('rent.languagesLabel', 'Languages')}
                  value={l.languages?.length > 0 ? l.languages.join(', ') : null}
                  color={COLORS.purpleDark}
                />
                <DetailRow
                  icon="location-outline"
                  label={t('rent.locationLabel', 'Location')}
                  value={l.location ? `${l.location}${l.district ? `, ${l.district}` : ''}` : null}
                  color={COLORS.cta}
                />
              </View>
            </>
          ) : null}

          {/* ── Description ── */}
          {l.description ? (
            <>
              <SectionTitle>{t('rent.aboutSection')}</SectionTitle>
              <Text style={D.descTxt}>{l.description}</Text>
            </>
          ) : null}

          {/* ── Availability window ──
              Colour tracks the resolved state, so a window that has closed no
              longer renders green, and one that has not opened yet reads amber.
              The text is a real translated sentence — it used to concatenate the
              badge word "Available" with a date, which is broken word order in
              every Indian language. */}
          {(l.availableFrom || l.availableTo) ? (
            <View style={[D.availWindowCard, { backgroundColor: AVAIL_UI.bg }]}>
              <Ionicons
                name={avail === 'ended' ? 'calendar-clear-outline' : 'calendar-outline'}
                size={16}
                color={AVAIL_UI.fg}
              />
              <Text style={[D.availWindowTxt, { color: AVAIL_UI.fg }]}>
                {avail === 'ended'
                  ? t('rent.availEnded', 'Availability ended {{date}}', { date: fmtDate(l.availableTo) })
                  : l.availableFrom && l.availableTo
                    ? t('rent.availWindow', 'Available {{from}} – {{to}}', { from: fmtDate(l.availableFrom), to: fmtDate(l.availableTo) })
                    : l.availableFrom
                      ? t('rent.availFrom', 'Available from {{date}}', { date: fmtDate(l.availableFrom) })
                      : t('rent.availUntil', 'Available until {{date}}', { date: fmtDate(l.availableTo) })}
              </Text>
            </View>
          ) : null}

        </View>
      </ScrollView>

      {/* ── Bottom action — owner edits; everyone else calls ── */}
      <View style={[D.bottomBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {isOwner ? (
          <View style={[D.bottomCallBtn, D.bottomOwnerBtn]}>
            <Ionicons name="person-circle-outline" size={22} color={COLORS.primary} />
            <Text style={[D.bottomCallTxt, { color: COLORS.primary }]} numberOfLines={1}>{t('rent.ownListingTitle', 'Your Listing')}</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[D.bottomCallBtn, revealing && { opacity: 0.6 }]}
            onPress={handleCall}
            disabled={revealing}
            accessibilityRole="button"
          >
            {revealing
              ? <ActivityIndicator size="small" color={COLORS.white} />
              : <Ionicons name="call" size={22} color={COLORS.white} />}
            <Text style={D.bottomCallTxt} numberOfLines={1}>
              {phone ? `${t('rent.callNow')}  •  ${phone}` : t('rent.callNow')}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Booking made popup ── */}
      <Modal visible={!!bookingDone} transparent animationType="fade" onRequestClose={() => setBookingDone(null)}>
        <View style={D.ovBackdrop}>
          <View style={D.ovCard}>
            <View style={D.ovIconCircle}>
              <Ionicons name="checkmark" size={34} color={COLORS.white} />
            </View>
            <Text style={D.ovTitle}>
              {bookingDone?.paid
                ? t('payments.bookingConfirmed', 'Booking confirmed')
                : t('rent.bookingSentTitle', 'Booking request sent!')}
            </Text>
            <Text style={D.ovBody}>
              {bookingDone?.paid
                ? t('payments.bookingConfirmedMsg', 'Your booking is confirmed. You can see it under My Bookings.')
                : t('rent.bookingSentMsg', 'The owner will review your request and confirm it shortly. You’ll be notified once it’s approved.')}
            </Text>
            {bookingDone?.start && bookingDone?.end ? (
              <Text style={D.ovPill} numberOfLines={2}>
                {fmtDate(bookingDone.start)} → {fmtDate(bookingDone.end)}
                {bookingDone.amount ? `  ·  ${inr(bookingDone.amount)}` : ''}
              </Text>
            ) : null}
            {bookingDone?.paidAmount ? (
              <Text style={D.ovPaid} numberOfLines={2}>
                {t('rent.advancePaid', { amount: inr(bookingDone.paidAmount), defaultValue: '{{amount}} advance paid' })}
              </Text>
            ) : null}
            <TouchableOpacity style={D.ovBtn} onPress={() => setBookingDone(null)} activeOpacity={0.85}>
              <Text style={D.ovBtnTxt}>{t('rent.done')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Payment sheet — `visible` is false until a real gateway order exists,
          so no WebView is mounted on a screen nobody is paying from. */}
      <RazorpayCheckout
        // Keyed on the gateway order so a SECOND booking attempt in the same
        // screen session gets a fresh component. RazorpayCheckout latches
        // `settled` after a success and never clears it, so a reused instance
        // would swallow the next attempt's dismissal — the one event this
        // whole flow is built to hear.
        key={rentBooking.checkoutProps.orderId || 'no-order'}
        {...rentBooking.checkoutProps}
        keyId={rentBooking.keyId}
        buyerName={user?.name}
        buyerPhone={user?.phone}
        description={l.name || l.leader}
      />

      {/* Asking the server what happened. Closing the sheet is NOT a failure —
          this overlay is what the farmer sees while we find out. */}
      <Modal visible={rentBooking.verifying} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={D.ovBackdrop}>
          <View style={[D.ovCard, { gap: 12 }]}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={D.ovTitle}>
              {rentBooking.verifyReason === 'dismiss'
                ? t('payments.dismissedCheck', 'Checking whether your payment went through…')
                : t('payments.verifying', 'Confirming your payment')}
            </Text>
            <Text style={D.ovBody}>
              {t('payments.doNotClose', 'Please do not close the app or pay again.')}
            </Text>
          </View>
        </View>
      </Modal>
    </View>
    </AnimatedScreen>
  );
}

const D = StyleSheet.create({
  root:   { flex: 1, backgroundColor: COLORS.background },

  // Gallery nav overlay
  galleryNav:  { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 },
  navBtn:      { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', alignItems: 'center' },

  galImg:   { width: W },
  dots:     { position: 'absolute', bottom: 28, width: '100%', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot:      { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.5)' },
  dotActive:{ backgroundColor: COLORS.white, width: 20 },

  // paddingTop is applied inline from the safe-area inset — see the render.
  avatarHero:    { paddingBottom: 48, alignItems: 'center', position: 'relative' },
  bigAvatar:     { width: 104, height: 104, borderRadius: 52, backgroundColor: 'rgba(255,255,255,0.18)', justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.5)' },
  bigAvatarTxt:  { fontSize: 38, fontWeight: '800', color: COLORS.white },

  // Content sits as a rounded sheet pulled up over the gallery / avatar header.
  content: { padding: 16, backgroundColor: COLORS.background, marginTop: -20, borderTopLeftRadius: 22, borderTopRightRadius: 22 },

  nameRow:    { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 10 },
  name:       { fontSize: 20, fontWeight: '800', color: COLORS.textDark },
  groupName:  { fontSize: 13, color: COLORS.textLight, marginTop: 2 },
  groupBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  groupBadgeTxt: { fontSize: 12, color: COLORS.primary, fontWeight: '700' },
  availBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 0 },
  availDot:   { width: 7, height: 7, borderRadius: 4 },
  availTxt:   { fontSize: 11, fontWeight: '700' },

  priceRow:  { flexDirection: 'row', gap: 10, marginBottom: 16, flexWrap: 'wrap' },
  priceCard: { backgroundColor: COLORS.primaryPale, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', minWidth: 90 },
  priceAmt:  { fontSize: 20, fontWeight: '900', color: COLORS.primary },
  priceLbl:  { fontSize: 11, color: COLORS.textLight, marginTop: 2 },
  ratingCard:{ backgroundColor: COLORS.yellowAmber, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  ratingTxt: { fontSize: 11, color: COLORS.amber, fontWeight: '700', marginTop: 4 },

  // Owner notice (shown instead of the call CTA on your own listing)
  ownerNotice:    { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.primaryPale, borderRadius: 16, padding: 14, marginBottom: 20, borderWidth: 1.5, borderColor: COLORS.primary + '40' },
  ownerNoticeTxt: { flex: 1, fontSize: 13, color: COLORS.primary, fontWeight: '700', lineHeight: 19 },

  // Call CTA card
  callCard:     { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: COLORS.primaryPale, borderRadius: 16, padding: 14, marginBottom: 20, borderWidth: 1.5, borderColor: COLORS.primary + '40', shadowColor: COLORS.black, shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  callCardIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center' },
  callCardTitle:{ fontSize: 16, fontWeight: '800', color: COLORS.textDark },
  callCardSub:  { fontSize: 13, color: COLORS.primary, fontWeight: '600', marginTop: 2 },

  // Accented section header
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, marginTop: 6 },
  sectionAccent:   { width: 3.5, height: 16, borderRadius: 2, backgroundColor: COLORS.primary },
  sectionTitle: { fontSize: 16, fontWeight: '800', color: COLORS.textDark },

  skillsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  skillChip:  { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.primaryPale, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  skillTxt:   { fontSize: 12, color: COLORS.primary, fontWeight: '700' },

  // Worker details card
  detailCard:  { backgroundColor: COLORS.white, borderRadius: 18, padding: 4, marginBottom: 16, shadowColor: COLORS.black, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 3 }, elevation: 3 },
  detailRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 10 },
  detailIcon:  { width: 36, height: 36, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  detailLabel: { fontSize: 11, color: COLORS.textLight, fontWeight: '600' },
  detailValue: { fontSize: 14, color: COLORS.textDark, fontWeight: '700', marginTop: 1 },

  descTxt: { fontSize: 14, color: COLORS.grayMid2, lineHeight: 22, marginBottom: 16 },

  // backgroundColor / color come from AVAIL_UI at render time.
  availWindowCard: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 14 },
  availWindowTxt:  { fontSize: 13, fontWeight: '700', flex: 1 },

  bottomBar:     { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 12, backgroundColor: COLORS.white, borderTopWidth: 1, borderTopColor: COLORS.lightGray2 },
  // gap:8 + paddingHorizontal keeps the icon and (possibly long) "Call • phone"
  // label comfortable; flexShrink + numberOfLines=1 prevent overflow on narrow
  // phones (e.g. Samsung S24). minHeight keeps a solid touch target.
  bottomCallBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary, borderRadius: 16, paddingVertical: 15, paddingHorizontal: 12, minHeight: 50 },
  bottomOwnerBtn:{ backgroundColor: COLORS.primaryPale, borderWidth: 1.5, borderColor: COLORS.primary + '40' },
  bottomCallTxt: { fontSize: fs(15), fontWeight: '800', color: COLORS.white, flexShrink: 1 },

  // Booking card
  bookCard:     { backgroundColor: COLORS.white, borderRadius: 16, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: COLORS.lightGray2, gap: 12 },
  bookHead:     { flexDirection: 'row', alignItems: 'center', gap: 7 },
  bookTitle:    { fontSize: fs(14), fontWeight: '800', color: COLORS.textDark },
  wcRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  wcLabel:      { fontSize: fs(13), color: COLORS.textMedium, fontWeight: '600', flexShrink: 1 },
  wcStepper:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wcBtn:        { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.primaryPale, justifyContent: 'center', alignItems: 'center' },
  wcValue:      { fontSize: fs(15), fontWeight: '800', color: COLORS.textDark, minWidth: 22, textAlign: 'center' },
  bookTotalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderTopWidth: 1, borderTopColor: COLORS.lightGray2, paddingTop: 10 },
  bookTotalLbl: { fontSize: fs(12), color: COLORS.textLight, flexShrink: 1 },
  bookTotalAmt: { fontSize: fs(16), fontWeight: '900', color: COLORS.primary },
  bookNotes:    { borderWidth: 1, borderColor: COLORS.lightGray2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: fs(13), color: COLORS.textDark, minHeight: 44, textAlignVertical: 'top' },
  bookBtn:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 13 },
  bookBtnTxt:   { fontSize: fs(14), fontWeight: '800', color: COLORS.white, flexShrink: 1 },

  // Shared overlay card (booking done / verifying a payment)
  ovBackdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  ovCard:       { width: '100%', maxWidth: 360, backgroundColor: COLORS.white, borderRadius: 20, padding: 24, alignItems: 'center' },
  ovIconCircle: { width: 62, height: 62, borderRadius: 31, backgroundColor: COLORS.primary, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  ovTitle:      { fontSize: fs(17), fontWeight: '800', color: COLORS.textDark, textAlign: 'center', marginBottom: 8 },
  ovBody:       { fontSize: fs(13), color: COLORS.textMedium, textAlign: 'center', lineHeight: 19, marginBottom: 12 },
  ovPill:       { fontSize: fs(13), fontWeight: '700', color: COLORS.primary, textAlign: 'center', marginBottom: 10 },
  ovPaid:       { fontSize: fs(12), fontWeight: '800', color: COLORS.primary, textAlign: 'center', marginBottom: 12 },
  ovBtn:        { width: '100%', backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ovBtnTxt:     { fontSize: fs(15), fontWeight: '800', color: COLORS.white },
});
