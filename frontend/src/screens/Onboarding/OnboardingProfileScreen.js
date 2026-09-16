/**
 * OnboardingProfileScreen — Screen 2/2: Farm profile setup.
 * KrushiSarva theme: forest-green gradient surface, themed section cards, single-green
 * selection (soil / irrigation / crops), Fraunces + Plus Jakarta Sans, gradient
 * CTA, entrance motion. Logic unchanged — only UI.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView,
  Platform, Image, Animated, Easing,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import LocationPicker from '@krushisarva/shared/components/LocationPicker';
import PincodeLocationStatus from '@krushisarva/shared/components/PincodeLocationStatus';
import { usePincodeAutofill } from '@krushisarva/shared/hooks/usePincodeLocation';
import { fitPatchToLocationLists } from '@krushisarva/shared/utils/pincode';
import SoilIcon from '../../components/SoilIcons';
import IrrigationIcon from '../../components/IrrigationIcons';
import PhotoIcon from '../../components/PhotoIcon';
import CropIcon from '@krushisarva/shared/components/CropIcons';
import { STATE_LIST, getDistrictsForState, getTalukas } from '@krushisarva/shared/constants/locations';
import { useAuth } from '@krushisarva/shared/context/AuthContext';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import { completeOnboarding, skipOnboarding } from '../../services/farmApi';
import { compressImage } from '@krushisarva/shared/utils/mediaCompressor';
import api from '@krushisarva/shared/services/api';
import { KHET, KFONT, KSHADOW } from '@krushisarva/shared/constants/khetTheme';
import { s, vs, fs, ms } from '../../utils/responsive';
import { webScreenContainer, useAbsoluteBarScrollStyle } from '../../utils/webScrollFix';
import { acresOrNull, cleanAcres, cleanPincode, findCrop, PINCODE_INPUT_MAX_LENGTH } from '../../utils/onboardingForm';
import { useKeyboardRoom } from '@krushisarva/shared/hooks/useKeyboardRoom';
import { revealScrollOffset } from '@krushisarva/shared/utils/keyboardInset';

const PLACEHOLDER = 'rgba(87,104,90,0.5)';
const IS_ANDROID = Platform.OS === 'android';
// Space kept between the focused field and the top of the keyboard.
const REVEAL_MARGIN = 24;
// Soil and crop grids: four cards per row (see sty.gridGutter).
const GRID_COLUMNS = 4;

const SOILS = [
  { key: 'BLACK_COTTON', label: 'Black Cotton', tKey: 'crops.soilBlack', sk: 'black', bg: ['#3E3631', '#1A1512'] },
  { key: 'RED', label: 'Red', tKey: 'crops.soilRed', sk: 'red', bg: ['#C45A3C', '#8B3626'] },
  { key: 'ALLUVIAL', label: 'Alluvial', tKey: 'crops.soilAlluvial', sk: 'alluvial', bg: ['#D4A76A', '#B8935A'] },
  { key: 'SANDY', label: 'Sandy', tKey: 'crops.soilSandy', sk: 'sandy', bg: ['#E8D5A3', '#C9B07A'] },
  { key: 'CLAY_LOAM', label: 'Clay Loam', tKey: 'crops.soilClay', sk: 'clay', bg: ['#8B7D6B', '#6B5D4B'] },
  { key: 'LATERITE', label: 'Laterite', tKey: 'crops.soilLaterite', sk: 'laterite', bg: ['#CD7F32', '#A0522D'] },
  { key: 'UNKNOWN', label: 'Not Sure', tKey: 'crops.soilNotSure', sk: null, bg: ['#9E9E9E', '#757575'] },
];

const IRRS = [
  { key: 'DRIP', label: 'Drip', tKey: 'crops.irrDrip', ik: 'drip' },
  { key: 'SPRINKLER', label: 'Sprinkler', tKey: 'crops.irrSprinkler', ik: 'sprinkler' },
  { key: 'FLOOD', label: 'Flood', tKey: 'crops.irrFlood', ik: 'flood' },
  { key: 'RAINFED', label: 'Rainfed', tKey: 'crops.irrRainfed', ik: 'rainfed' },
  { key: 'MIXED', label: 'Mixed', tKey: 'crops.irrMixed', ik: null },
];

const CROPS = [
  'Soybean', 'Cotton', 'Rice', 'Wheat', 'Maize', 'Sugarcane',
  'Onion', 'Tomato', 'Chilli', 'Potato', 'Groundnut', 'Jowar',
  'Bajra', 'Turmeric', 'Pomegranate', 'Grape', 'Mango', 'Banana',
  'Brinjal', 'Okra', 'Cauliflower', 'Cabbage', 'Sunflower', 'Ginger',
];

// Reusable themed section icon (green accent square)
function SectionIcon({ name }) {
  return (
    <View style={sty.sectionIcon}>
      <Ionicons name={name} size={16} color={KHET.primary} />
    </View>
  );
}

// Entrance fade-in-up wrapper (staggered)
function Rise({ delay = 0, children, style }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, { toValue: 1, duration: 420, delay, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, []);
  const translateY = a.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });
  return <Animated.View style={[style, { opacity: a, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

export default function OnboardingProfileScreen({ navigation }) {
  const { t } = useLanguage();
  const { updateUser } = useAuth();
  const insets = useSafeAreaInsets();
  const scrollStyle = useAbsoluteBarScrollStyle();
  const scrollRef = useRef(null);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // Android is edge-to-edge on Expo SDK 54: the window is not resized for the
  // keyboard, so Village, Pincode, Farm name, Land size and the "Other" crop
  // field sat under it. The scroll viewport is padded by the covered strip and
  // the focused field is scrolled into view (same approach as the login screen).
  const keyboard = useKeyboardRoom(insets.bottom);
  const viewportRef = useRef(0);
  const scrollYRef = useRef(0);
  const focusedRef = useRef(null);
  const firstNameRef = useRef(null);
  const lastNameRef = useRef(null);
  const talukaRef = useRef(null);
  const villageRef = useRef(null);
  const pincodeRef = useRef(null);
  const farmNameRef = useRef(null);
  const landSizeRef = useRef(null);
  const customCropRef = useRef(null);

  const revealField = useCallback((fieldRef) => {
    if (Platform.OS === 'web') return;
    requestAnimationFrame(() => {
      const field = fieldRef?.current;
      const scroller = scrollRef.current;
      if (!field || !scroller || !keyboard.visibleRef.current) return;
      const inner = scroller.getInnerViewRef?.();
      if (!inner || typeof field.measureLayout !== 'function') return;
      field.measureLayout(
        inner,
        (_x, y, _w, h) => {
          const target = revealScrollOffset({
            blockTop: y,
            blockHeight: h,
            viewportHeight: viewportRef.current,
            scrollY: scrollYRef.current,
            margin: REVEAL_MARGIN,
          });
          if (target != null) scroller.scrollTo({ y: target, animated: true });
        },
        () => {},
      );
    });
  }, [keyboard.visibleRef]);

  // The viewport shrinks when room is made for the keyboard (Android padding,
  // iOS KeyboardAvoidingView) — that is when the focused field can move.
  const onViewportLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    const shrank = viewportRef.current > 0 && h < viewportRef.current - 1;
    viewportRef.current = h;
    if (shrank && focusedRef.current) revealField(focusedRef.current);
  }, [revealField]);

  const onScroll = useCallback((e) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  // Moving between fields with the keyboard already open changes no layout, so
  // focus reveals too.
  const fieldProps = (ref) => ({
    ref,
    onFocus: () => { focusedRef.current = ref; revealField(ref); },
  });

  // The bottom bar floats over the form; its height depends on the navigation
  // bar inset and the phone's font size, so the end spacer is measured.
  const [barHeight, setBarHeight] = useState(vs(110));
  const onBarLayout = useCallback((e) => {
    const h = Math.ceil(e.nativeEvent.layout.height);
    setBarHeight((prev) => (prev === h ? prev : h));
  }, []);

  // Profile photo
  const [avatarUri, setAvatarUri] = useState(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // Name
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');

  // Location
  const [state, setState] = useState('Maharashtra');
  const [district, setDistrict] = useState('');
  const [taluka, setTaluka] = useState('');
  const [village, setVillage] = useState('');
  const [pincode, setPincode] = useState('');
  const [lat, setLat] = useState(null);
  const [lng, setLng] = useState(null);
  const [gpsLoading, setGpsLoading] = useState(false);

  // Farm
  const [farmName, setFarmName] = useState('');
  const [landSize, setLandSize] = useState('');
  const [soilType, setSoilType] = useState('');
  const [irrigation, setIrrigation] = useState('');

  // Crops
  const [selectedCrops, setSelectedCrops] = useState(new Set());

  // UI
  const [saving, setSaving] = useState(false);

  // PIN code → state / district / taluka / village. The pickers only accept
  // names from their own lists, so anything else India Post returns is dropped
  // here rather than shown as a selection the picker can't display.
  const applyLocation = (patch) => {
    const fit = fitPatchToLocationLists({ state, district, taluka }, patch);
    if ('state' in fit) setState(fit.state);
    if ('district' in fit) setDistrict(fit.district);
    if ('taluka' in fit) setTaluka(fit.taluka);
    if ('village' in fit) setVillage(fit.village);
  };
  const pin = usePincodeAutofill({
    pincode,
    values: { state, district, taluka, village },
    fields: { state: 'state', district: 'district', taluka: 'taluka', village: 'village' },
    strict: ['state', 'district'],
    onChange: applyLocation,
  });

  const canSubmit = firstName.trim().length >= 1 && district.trim().length > 0 && !pin.blocksSubmit;
  const submitHint = pin.blocksSubmit && firstName.trim() && district.trim()
    ? t('pincode.fixBeforeSave')
    : t('onboarding.fillNameDistrict');

  const toggleCrop = (crop) => setSelectedCrops(p => {
    const n = new Set(p); n.has(crop) ? n.delete(crop) : n.add(crop); return n;
  });

  // ── "Other" — crops typed manually by the user ────────────────────────────
  const [customCrop, setCustomCrop] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const customCrops = Array.from(selectedCrops).filter((c) => !CROPS.includes(c));
  const addCustomCrop = () => {
    const name = customCrop.trim().replace(/\s+/g, ' ');
    if (!name) return;
    // "rice" selects the Rice card, and a crop already added is not added again
    // under a different case.
    const existing = findCrop(name, [...CROPS, ...selectedCrops]);
    setSelectedCrops((p) => new Set(p).add(existing ?? name));
    setCustomCrop('');
  };

  // ── Profile Photo ─────────────────────────────────────────────────────────
  const handlePickPhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('onboarding.permissionTitle'), t('profile.photoPermission'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true, aspect: [1, 1], quality: 0.7,
    });
    if (result.canceled) return;

    const asset = result.assets[0];
    const mime = (asset.mimeType || asset.type || '').toLowerCase();
    const ext  = (asset.uri.split('.').pop() || '').toLowerCase();
    const isValidType = ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
      || mime.includes('jpeg') || mime.includes('png') || mime.includes('webp');
    if (!isValidType) {
      Alert.alert(t('profile.invalidFileType'), t('profile.invalidFileMsg'));
      return;
    }

    setUploadingPhoto(true);
    try {
      const { uri: compressedUri } = await compressImage(asset.uri);
      setAvatarUri(compressedUri);
      const formData = new FormData();
      formData.append('file', {
        uri: Platform.OS === 'android' ? compressedUri : compressedUri.replace('file://', ''),
        name: 'avatar.jpg',
        type: 'image/jpeg',
      });
      const { data } = await api.put('/users/me', formData);
      updateUser({ avatar: data.data.avatar });
      setAvatarUri(data.data.avatar || compressedUri);
    } catch {
      Alert.alert(t('profile.uploadFailed'), t('profile.uploadFailedMsg'));
      setAvatarUri(null);
    } finally {
      setUploadingPhoto(false);
    }
  }, [updateUser]);

  // ── GPS ────────────────────────────────────────────────────────────────────
  const captureGPS = async () => {
    setGpsLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert(t('onboarding.permissionTitle'), t('onboarding.enableLocation')); return; }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLat(loc.coords.latitude); setLng(loc.coords.longitude);
    } catch { Alert.alert(t('farmProfile.gpsErrorTitle'), t('farmProfile.gpsErrorMsg')); }
    finally { setGpsLoading(false); }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleComplete = async () => {
    setSaving(true);
    try {
      const result = await completeOnboarding({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        farmName: farmName.trim() || `${firstName.trim()}'s Farm`,
        state, district, taluka, village, pincode,
        latitude: lat, longitude: lng,
        landSizeAcres: acresOrNull(landSize),
        soilType: soilType || 'UNKNOWN',
        irrigationType: irrigation || 'RAINFED',
        cropTypes: Array.from(selectedCrops),
      });
      updateUser({
        name: result.user?.name,
        onboardingStep: 'COMPLETE',
        state: result.user?.state || state,
        district: result.user?.district || district,
        taluka: result.user?.taluka || taluka,
        village: result.user?.village || village,
        pincode: result.user?.pincode || pincode,
        totalFarms: 1,
      });
    } catch (err) {
      Alert.alert(t('login.error'), err.response?.data?.error?.message || err.message || t('onboarding.failedTryAgain'));
    } finally { setSaving(false); }
  };

  const handleSkip = async () => {
    setSaving(true);
    try {
      await skipOnboarding();
      updateUser({ onboardingStep: 'COMPLETE' });
    } catch { Alert.alert(t('login.error'), t('onboarding.failedToSkip')); }
    finally { setSaving(false); }
  };

  // ── Progress ───────────────────────────────────────────────────────────────
  const filledSections = [
    firstName.trim().length > 0,
    district.trim().length > 0,
    landSize.trim().length > 0 && soilType.length > 0,
    selectedCrops.size > 0,
  ].filter(Boolean).length;

  const initials = firstName.trim() ? firstName.trim()[0].toUpperCase() : '?';

  return (
    <LinearGradient
      colors={KHET.gradSurface}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.7, y: 1 }}
      style={[sty.container, webScreenContainer]}
      onLayout={keyboard.onRootLayout}
    >
      <View style={[sty.blob, { backgroundColor: KHET.primaryGlow, top: -90, right: -90 }]} pointerEvents="none" />
      {/* iOS: KeyboardAvoidingView pads. Android: the window is not resized for
          the keyboard (edge-to-edge), so pad by the strip it covers. The inset
          subtracts anything the window did give back, so it never counts twice. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[{ flex: 1, minHeight: 0 }, IS_ANDROID ? { paddingBottom: keyboard.inset } : null]}
      >
        <ScrollView
          ref={scrollRef}
          style={scrollStyle}
          contentContainerStyle={[sty.scroll, { paddingTop: insets.top + vs(12) }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onLayout={onViewportLayout}
          onScroll={onScroll}
          scrollEventThrottle={32}
        >

          {/* ── Header with back ─────────────────────────────────────────── */}
          <View style={sty.headerRow}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={sty.backBtn} activeOpacity={0.8}>
              <Ionicons name="arrow-back" size={18} color={KHET.foreground} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={sty.headerTitle}>{t('onboarding.profileTitle')}</Text>
              <Text style={sty.headerSub}>{t('onboarding.nameSub')}</Text>
            </View>
          </View>

          {/* Progress bar */}
          <View style={sty.progressBar}>
            <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={[sty.progressFill, { width: `${Math.max(8, (filledSections / 4) * 100)}%` }]} />
          </View>

          {/* ── Profile Photo ────────────────────────────────────────────── */}
          <Rise delay={40} style={sty.photoSection}>
            <TouchableOpacity style={sty.avatarWrap} onPress={handlePickPhoto} activeOpacity={0.85}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={sty.avatarImg} />
              ) : (
                <View style={sty.avatarPlaceholder}>
                  <Text style={sty.avatarInitial}>{initials}</Text>
                </View>
              )}
              <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={sty.cameraBtn}>
                {uploadingPhoto
                  ? <ActivityIndicator size="small" color="#FFF" />
                  : <Ionicons name="camera" size={14} color="#FFF" />}
              </LinearGradient>
            </TouchableOpacity>
            <Text style={sty.photoHint}>{t('onboarding.tapAddPhoto')}</Text>
          </Rise>

          {/* ── 1. Your Name ─────────────────────────────────────────────── */}
          <Rise delay={90} style={sty.section}>
            <View style={sty.sectionHeader}>
              <SectionIcon name="person-outline" />
              <Text style={sty.sectionTitle}>{t('onboarding.yourName')}</Text>
              <Text style={sty.required}>*</Text>
            </View>
            <View style={sty.row}>
              <View style={{ flex: 1 }}>
                <TextInput {...fieldProps(firstNameRef)} style={sty.input} value={firstName} onChangeText={setFirstName}
                  placeholder={t('onboarding.firstName')} placeholderTextColor={PLACEHOLDER} maxLength={50}
                  autoCapitalize="words" />
              </View>
              <View style={{ flex: 1 }}>
                <TextInput {...fieldProps(lastNameRef)} style={sty.input} value={lastName} onChangeText={setLastName}
                  placeholder={t('onboarding.lastName')} placeholderTextColor={PLACEHOLDER} maxLength={50}
                  autoCapitalize="words" />
              </View>
            </View>
          </Rise>

          {/* ── 2. Farm Location ──────────────────────────────────────────── */}
          <Rise delay={140} style={sty.section}>
            <View style={sty.sectionHeader}>
              <SectionIcon name="location-outline" />
              <Text style={sty.sectionTitle}>{t('farmProfile.farmLocation')}</Text>
              <Text style={sty.required}>*</Text>
            </View>

            {/* PIN first: it fills everything below it. */}
            <Text style={sty.fieldLabel}>{t('farmProfile.pincode')}</Text>
            {/* number-pad has no "." or "-", and cleanPincode drops anything a
                paste or suggestion brings in. */}
            <TextInput {...fieldProps(pincodeRef)} style={sty.input} value={pincode}
              onChangeText={(v) => setPincode(cleanPincode(v))}
              placeholder={t('onboarding.pincodePlaceholder')} keyboardType="number-pad"
              maxLength={PINCODE_INPUT_MAX_LENGTH} placeholderTextColor={PLACEHOLDER} />
            {pin.status === 'idle' ? (
              <Text style={sty.pinHint}>{t('pincode.autofillHint')}</Text>
            ) : (
              <PincodeLocationStatus lookup={pin}
                pickerTriggerStyle={sty.pickerTrigger} pickerTriggerTextStyle={sty.pickerText} />
            )}

            <Text style={sty.fieldLabel}>{t('farmProfile.selectState')}</Text>
            <LocationPicker title={t('farmProfile.selectState')} items={STATE_LIST} selected={state}
              onSelect={v => { setState(v); setDistrict(''); setTaluka(''); }}
              placeholder={t('farmProfile.selectStatePlaceholder')}
              triggerStyle={sty.pickerTrigger} triggerTextStyle={sty.pickerText} />

            <Text style={sty.fieldLabel}>{t('onboarding.selectDistrict')} *</Text>
            <LocationPicker title={t('onboarding.selectDistrict')} items={getDistrictsForState(state)} selected={district}
              onSelect={v => { setDistrict(v); setTaluka(''); }}
              placeholder={t('onboarding.selectDistrictPlaceholder')} disabled={!state}
              triggerStyle={sty.pickerTrigger} triggerTextStyle={sty.pickerText} />

            <Text style={sty.fieldLabel}>{t('farmProfile.taluka')}</Text>
            {state === 'Maharashtra' ? (
              <LocationPicker title={t('onboarding.selectTaluka')} items={getTalukas(district)} selected={taluka}
                onSelect={setTaluka} placeholder={t('onboarding.selectTalukaPlaceholder')} disabled={!district}
                triggerStyle={sty.pickerTrigger} triggerTextStyle={sty.pickerText} />
            ) : (
              <TextInput {...fieldProps(talukaRef)} style={sty.input} value={taluka} onChangeText={setTaluka}
                placeholder={t('onboarding.talukaPlaceholder')} placeholderTextColor={PLACEHOLDER} />
            )}

            <Text style={sty.fieldLabel}>{t('farmProfile.village')}</Text>
            <TextInput {...fieldProps(villageRef)} style={sty.input} value={village} onChangeText={setVillage}
              placeholder={t('onboarding.enterVillage')} placeholderTextColor={PLACEHOLDER} />

            <TouchableOpacity style={sty.gpsBtn} onPress={captureGPS} disabled={gpsLoading} activeOpacity={0.8}>
              <Ionicons name={lat ? 'checkmark-circle' : 'navigate-outline'} size={16} color={KHET.primary} />
              <Text style={sty.gpsTxt}>
                {gpsLoading ? t('onboarding.gettingLocation') : lat ? t('onboarding.gpsCaptured', { lat: lat.toFixed(4), lng: lng.toFixed(4) }) : t('onboarding.detectLocation')}
              </Text>
            </TouchableOpacity>
          </Rise>

          {/* ── 3. Farm Details ───────────────────────────────────────────── */}
          <Rise delay={190} style={sty.section}>
            <View style={sty.sectionHeader}>
              <SectionIcon name="leaf-outline" />
              <Text style={sty.sectionTitle}>{t('farmDetails')}</Text>
            </View>

            <Text style={sty.fieldLabel}>{t('farmProfile.farmName')}</Text>
            <TextInput {...fieldProps(farmNameRef)} style={sty.input} value={farmName} onChangeText={setFarmName}
              placeholder={t('onboarding.farmNamePlaceholderOwner', { owner: firstName.trim() || 'My' })} placeholderTextColor={PLACEHOLDER} maxLength={60} />

            <Text style={[sty.fieldLabel, { marginTop: vs(14) }]}>{t('onboarding.landSize')}</Text>
            <TextInput {...fieldProps(landSizeRef)} style={[sty.input, { textAlign: 'center', fontSize: fs(18), fontFamily: KFONT.sansBold }]}
              value={landSize} onChangeText={(v) => setLandSize(cleanAcres(v))}
              placeholder={t('farmProfile.landSizePlaceholder')} keyboardType="decimal-pad" placeholderTextColor={PLACEHOLDER} />

            <Text style={[sty.fieldLabel, { marginTop: vs(14) }]}>{t('farmProfile.soilType')}</Text>
            <View style={sty.soilGrid}>
              {SOILS.map((soil, i) => {
                const sel = soilType === soil.key;
                return (
                  <TouchableOpacity key={soil.key} style={[sty.soilCard, i % GRID_COLUMNS !== GRID_COLUMNS - 1 && sty.gridGutter]}
                    onPress={() => setSoilType(soil.key)} activeOpacity={0.8}
                    accessibilityRole="radio" accessibilityState={{ selected: sel }}>
                    <LinearGradient colors={soil.bg} style={[sty.soilSquare, sel && sty.soilSquareSel]}>
                      {soil.sk ? <SoilIcon type={soil.sk} size={30} /> : <Ionicons name="help-circle" size={30} color={KHET.gold} />}
                      {sel && <View style={sty.soilCheck}><Ionicons name="checkmark" size={10} color="#FFF" /></View>}
                    </LinearGradient>
                    <Text style={[sty.soilLabel, sel && sty.soilLabelSel]} numberOfLines={2}
                      adjustsFontSizeToFit minimumFontScale={0.8}>
                      {t(soil.tKey, soil.label)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[sty.fieldLabel, { marginTop: vs(14) }]}>{t('farmProfile.irrigationLabel')}</Text>
            <View style={sty.irrRow}>
              {IRRS.map(irr => {
                const sel = irrigation === irr.key;
                return (
                  <TouchableOpacity key={irr.key} style={[sty.irrChip, sel && sty.irrChipSel]} onPress={() => setIrrigation(irr.key)} activeOpacity={0.8}>
                    <View style={[sty.irrIconSmall, sel && sty.irrIconSmallSel]}>
                      {irr.ik ? <IrrigationIcon type={irr.ik} size={20} /> : <Ionicons name="shuffle" size={18} color={KHET.gold} />}
                    </View>
                    <Text style={[sty.irrLabel, sel && sty.irrLabelSel]}>{t(irr.tKey, irr.label)}</Text>
                    {sel && <Ionicons name="checkmark-circle" size={14} color={KHET.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Rise>

          {/* ── 4. Crops ──────────────────────────────────────────────────── */}
          <Rise delay={240} style={sty.section}>
            <View style={sty.sectionHeader}>
              <SectionIcon name="nutrition-outline" />
              <Text style={sty.sectionTitle}>{t('onboarding.cropsTitle')}</Text>
              {selectedCrops.size > 0 && (
                <View style={sty.cropBadge}><Text style={sty.cropBadgeText}>{selectedCrops.size}</Text></View>
              )}
            </View>
            <View style={sty.cropGrid}>
              {CROPS.map((crop, i) => {
                const sel = selectedCrops.has(crop);
                return (
                  <TouchableOpacity key={crop}
                    style={[sty.cropCard, i % GRID_COLUMNS !== GRID_COLUMNS - 1 && sty.gridGutter, sel && sty.cropCardSel]}
                    onPress={() => toggleCrop(crop)} activeOpacity={0.8}
                    accessibilityRole="checkbox" accessibilityState={{ checked: sel }}>
                    <PhotoIcon set="crop" name={crop} size={40} radius={8}
                      fallback={<CropIcon crop={crop} size={28} />} />
                    {/* One word ("Pomegranate") cannot wrap, so it shrinks to fit
                        instead of being cut to "Pomegra…". */}
                    <Text style={[sty.cropName, sel && sty.cropNameSel]} numberOfLines={1}
                      adjustsFontSizeToFit minimumFontScale={0.7}>
                      {t('crops.' + crop.toLowerCase(), crop)}
                    </Text>
                    {sel && <Ionicons name="checkmark-circle" size={14} color={KHET.primary} style={{ position: 'absolute', top: 3, right: 3 }} />}
                  </TouchableOpacity>
                );
              })}

              {/* "Other" — add a crop manually. It is the 25th card, so it starts a row. */}
              <TouchableOpacity style={[sty.cropCard, showCustom && sty.cropCardSel]} onPress={() => setShowCustom(v => !v)} activeOpacity={0.8}
                accessibilityRole="button" accessibilityState={{ expanded: showCustom }}>
                <View style={sty.otherIcon}>
                  <Ionicons name="add" size={22} color={KHET.primary} />
                </View>
                <Text style={[sty.cropName, showCustom && sty.cropNameSel]} numberOfLines={1}
                  adjustsFontSizeToFit minimumFontScale={0.7}>
                  {t('common.other', 'Other')}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Manual crop entry */}
            {showCustom && (
              <View style={sty.customRow}>
                {/* scrollToEnd used to run here, which scrolled the end SPACER into
                    view and left this field under the keyboard. */}
                <TextInput
                  {...fieldProps(customCropRef)}
                  style={sty.customInput}
                  value={customCrop}
                  onChangeText={setCustomCrop}
                  placeholder={t('onboarding.typeCropName', 'Type crop name')}
                  placeholderTextColor={PLACEHOLDER}
                  onSubmitEditing={addCustomCrop}
                  // Keep the keyboard up so several crops can be added in a row.
                  submitBehavior="submit"
                  returnKeyType="done"
                  maxLength={30}
                  autoFocus
                />
                <TouchableOpacity
                  style={[sty.customAddBtn, !customCrop.trim() && { opacity: 0.5 }]}
                  onPress={addCustomCrop} disabled={!customCrop.trim()} activeOpacity={0.85}
                >
                  <Ionicons name="add" size={22} color={KHET.primaryForeground} />
                </TouchableOpacity>
              </View>
            )}

            {/* Custom crops the user added */}
            {customCrops.length > 0 && (
              <View style={sty.customChips}>
                {customCrops.map(c => (
                  <View key={c} style={sty.customChip}>
                    <Text style={sty.customChipTxt}>{c}</Text>
                    <TouchableOpacity onPress={() => toggleCrop(c)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}>
                      <Ionicons name="close-circle" size={16} color={KHET.primary} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
          </Rise>

          <View style={{ height: barHeight + vs(20) }} />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Fixed Bottom Bar ──────────────────────────────────────────── */}
      {/* The navigation bar is drawn over the app (edge-to-edge): without the
          inset, Skip and Complete sat under the system back/home buttons. */}
      <View style={[sty.bottomBar, { paddingBottom: insets.bottom + vs(12) }]} onLayout={onBarLayout}>
        <TouchableOpacity style={[sty.skipBtn, saving && { opacity: 0.5 }]} onPress={handleSkip} disabled={saving} activeOpacity={0.8}>
          <Text style={sty.skipTxt}>{t('onboarding.skip')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[sty.submitBtn, !canSubmit && { opacity: 0.55 }]}
          onPress={handleComplete}
          disabled={saving || !canSubmit}
          activeOpacity={0.9}
        >
          <LinearGradient colors={KHET.gradPrimary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={sty.submitGrad}>
            {saving ? <ActivityIndicator color="#FFF" /> : (
              <>
                {/* Up to two lines: "Fill name & district" runs long in Tamil and
                    Malayalam and was cut off beside the Skip button. */}
                <Text style={sty.submitTxt} numberOfLines={2}>
                  {canSubmit ? t('onboarding.completeSetup') : submitHint}
                </Text>
                {canSubmit && (
                  <View style={sty.submitArrow}><Ionicons name="checkmark" size={16} color={KHET.primaryForeground} /></View>
                )}
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const sty = StyleSheet.create({
  container: { flex: 1, backgroundColor: KHET.background },
  // paddingTop is the top safe-area inset + vs(12), set inline.
  scroll: { paddingHorizontal: s(20) },
  blob: { position: 'absolute', width: s(260), height: s(260), borderRadius: s(130), opacity: 0.16 },

  // Header
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: s(12), marginBottom: vs(12) },
  backBtn: {
    width: s(40), height: s(40), borderRadius: s(20),
    backgroundColor: 'rgba(255,255,255,0.7)', borderWidth: 1, borderColor: KHET.border,
    justifyContent: 'center', alignItems: 'center', ...KSHADOW.soft,
  },
  headerTitle: { fontSize: fs(24), fontFamily: KFONT.display, color: KHET.foreground, letterSpacing: -0.4 },
  headerSub: { fontSize: fs(12), color: KHET.mutedForeground, marginTop: vs(2), fontFamily: KFONT.sans },

  // Progress
  progressBar: { height: 5, borderRadius: 3, backgroundColor: KHET.border, overflow: 'hidden', marginBottom: vs(20) },
  progressFill: { height: '100%', borderRadius: 3 },

  // Photo
  photoSection: { alignItems: 'center', marginBottom: vs(20) },
  avatarWrap: { position: 'relative' },
  avatarImg: { width: ms(90), height: ms(90), borderRadius: ms(30), backgroundColor: KHET.muted },
  avatarPlaceholder: {
    width: ms(90), height: ms(90), borderRadius: ms(30),
    backgroundColor: KHET.accent, justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: 'rgba(0,95,33,0.25)', borderStyle: 'dashed',
  },
  avatarInitial: { fontSize: fs(32), fontFamily: KFONT.displaySemi, color: KHET.primary },
  cameraBtn: {
    position: 'absolute', bottom: 0, right: 0,
    width: ms(30), height: ms(30), borderRadius: ms(15),
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#FFFFFF',
  },
  photoHint: { fontSize: fs(12), color: KHET.mutedForeground, marginTop: vs(8), fontFamily: KFONT.sans },

  // Sections
  section: {
    backgroundColor: KHET.card, borderRadius: s(18),
    padding: s(16), marginBottom: vs(12),
    borderWidth: 1, borderColor: KHET.border, ...KSHADOW.soft,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: s(8), marginBottom: vs(12) },
  sectionIcon: {
    width: s(30), height: s(30), borderRadius: s(10),
    backgroundColor: KHET.accent, justifyContent: 'center', alignItems: 'center',
  },
  sectionTitle: { fontSize: fs(16), fontFamily: KFONT.sansBold, color: KHET.foreground, flex: 1 },
  required: { fontSize: fs(14), color: KHET.destructive, fontFamily: KFONT.sansBold },

  // Inputs
  row: { flexDirection: 'row', gap: s(10) },
  input: {
    borderWidth: 1.5, borderColor: KHET.border, borderRadius: s(12),
    paddingHorizontal: s(14), paddingVertical: vs(12),
    fontSize: fs(15), color: KHET.foreground, backgroundColor: KHET.input, fontFamily: KFONT.sans,
  },
  fieldLabel: { fontSize: fs(12), fontFamily: KFONT.sansSemi, color: KHET.mutedForeground, marginBottom: vs(6), marginTop: vs(8), letterSpacing: 0.2 },
  // State / district / taluka pickers look like the text inputs beside them
  // (the picker's own default is the older white, 1px-border style).
  pickerTrigger: {
    borderWidth: 1.5, borderColor: KHET.border, borderRadius: s(12),
    paddingHorizontal: s(14), paddingVertical: vs(12),
    backgroundColor: KHET.input, elevation: 0, shadowOpacity: 0,
  },
  pickerText: { fontSize: fs(15), color: KHET.foreground, fontFamily: KFONT.sans },
  pinHint: { fontSize: fs(12), color: KHET.mutedForeground, fontFamily: KFONT.sans, marginTop: vs(6) },

  // GPS
  gpsBtn: {
    flexDirection: 'row', alignItems: 'center', gap: s(8),
    marginTop: vs(12), paddingVertical: vs(11), paddingHorizontal: s(12),
    borderWidth: 1.5, borderColor: 'rgba(0,95,33,0.25)', borderRadius: s(12),
    borderStyle: 'dashed', backgroundColor: 'rgba(201,242,192,0.4)',
  },
  gpsTxt: { fontSize: fs(13), color: KHET.primary, fontFamily: KFONT.sansSemi },

  // Soil and crop grids — four cards per row. Seven soils in one row made each
  // square ~37dp (under the 48dp tap minimum) with an 8px label, and crop names
  // were 9px. Each card is 23.5% wide with a 2% gutter after all but the last in
  // a row: 4 × 23.5 + 3 × 2 = 100%, so a short last row still lines up under the
  // columns above (space-between would spread it across the width instead).
  gridGutter: { marginRight: '2%' },
  soilGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: vs(10) },
  soilCard: { width: '23.5%', alignItems: 'center' },
  soilSquare: {
    width: '100%', aspectRatio: 1, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0)',
  },
  soilSquareSel: { borderColor: KHET.primary, elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 3 },
  soilCheck: { position: 'absolute', top: 4, right: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: KHET.primary, justifyContent: 'center', alignItems: 'center' },
  soilLabel: { fontSize: fs(11), lineHeight: fs(14), color: KHET.mutedForeground, marginTop: vs(4), textAlign: 'center', fontFamily: KFONT.sans },
  soilLabelSel: { color: KHET.primary, fontFamily: KFONT.sansBold },

  // Irrigation chips
  irrRow: { flexDirection: 'row', flexWrap: 'wrap', gap: s(8) },
  irrChip: {
    flexDirection: 'row', alignItems: 'center', gap: s(6),
    paddingVertical: vs(8), paddingHorizontal: s(10),
    borderRadius: s(12), borderWidth: 1.5, borderColor: KHET.border, backgroundColor: KHET.card,
  },
  irrChipSel: { borderColor: KHET.primary, borderWidth: 2, backgroundColor: KHET.accent },
  irrIconSmall: { width: s(28), height: s(28), borderRadius: s(8), backgroundColor: KHET.secondary, justifyContent: 'center', alignItems: 'center' },
  irrIconSmallSel: { backgroundColor: 'rgba(255,255,255,0.65)' },
  irrLabel: { fontSize: fs(12), fontFamily: KFONT.sansSemi, color: KHET.mutedForeground },
  irrLabelSel: { color: KHET.primary, fontFamily: KFONT.sansBold },

  // Crops
  cropBadge: { backgroundColor: KHET.primary, borderRadius: 10, paddingHorizontal: s(8), paddingVertical: vs(2) },
  cropBadgeText: { color: '#FFF', fontSize: fs(11), fontFamily: KFONT.sansBold },
  cropGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: s(8) },
  cropCard: {
    width: '23.5%', backgroundColor: KHET.card, borderRadius: 12,
    paddingVertical: s(8), paddingHorizontal: s(4), alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: KHET.border, position: 'relative',
  },
  cropCardSel: { borderColor: KHET.primary, borderWidth: 2, backgroundColor: KHET.accent },
  cropName: { fontSize: fs(11), lineHeight: fs(14), color: KHET.mutedForeground, textAlign: 'center', marginTop: vs(4), fontFamily: KFONT.sans, alignSelf: 'stretch' },
  cropNameSel: { color: KHET.primary, fontFamily: KFONT.sansBold },
  // Same footprint as a crop photo (40), so the "Other" card is as tall as the rest.
  otherIcon: { width: 40, height: 40, borderRadius: 8, backgroundColor: KHET.accent, justifyContent: 'center', alignItems: 'center' },

  // Custom ("Other") crop entry
  customRow: { flexDirection: 'row', alignItems: 'center', gap: s(8), marginTop: vs(12) },
  customInput: {
    flex: 1, borderWidth: 1.5, borderColor: KHET.border, borderRadius: s(12),
    paddingHorizontal: s(14), paddingVertical: vs(11),
    fontSize: fs(14), color: KHET.foreground, backgroundColor: KHET.input, fontFamily: KFONT.sans,
  },
  customAddBtn: { width: s(46), height: s(46), borderRadius: s(12), backgroundColor: KHET.primary, justifyContent: 'center', alignItems: 'center', ...KSHADOW.soft },
  customChips: { flexDirection: 'row', flexWrap: 'wrap', gap: s(8), marginTop: vs(12) },
  customChip: {
    flexDirection: 'row', alignItems: 'center', gap: s(6),
    paddingVertical: vs(6), paddingHorizontal: s(10),
    borderRadius: 999, borderWidth: 1.5, borderColor: KHET.primary, backgroundColor: KHET.accent,
  },
  customChipTxt: { fontSize: fs(13), fontFamily: KFONT.sansSemi, color: KHET.primary },

  // Bottom bar
  // paddingBottom is the bottom safe-area inset + vs(12), set inline.
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', gap: s(10),
    paddingHorizontal: s(20), paddingTop: vs(12),
    backgroundColor: KHET.card,
    borderTopWidth: 1, borderTopColor: KHET.border, ...KSHADOW.soft,
  },
  skipBtn: {
    paddingVertical: vs(14), paddingHorizontal: s(18),
    borderRadius: 999, borderWidth: 1.5, borderColor: KHET.border, justifyContent: 'center',
  },
  skipTxt: { fontSize: fs(14), color: KHET.mutedForeground, fontFamily: KFONT.sansSemi },
  submitBtn: { flex: 1, borderRadius: 18, overflow: 'hidden' },
  submitGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: s(8), paddingVertical: vs(15), paddingHorizontal: s(12), ...KSHADOW.elegant,
  },
  submitTxt: { color: KHET.primaryForeground, fontSize: fs(15), fontFamily: KFONT.sansSemi, textAlign: 'center', flexShrink: 1 },
  submitArrow: { width: s(26), height: s(26), borderRadius: s(13), backgroundColor: 'rgba(255,255,255,0.18)', justifyContent: 'center', alignItems: 'center' },
});
