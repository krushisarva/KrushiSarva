/**
 * AddProductScreen — create / edit a listing.
 *
 * Payload, endpoints and field names are unchanged.
 *
 * THE FORM HAS A SHAPE NOW
 * ------------------------
 * This is the longest form in the app and the one sellers abandon. Three
 * things were added to make the distance legible instead of infinite:
 *
 *   1. A progress card at the top counting the five REQUIRED fields — not the
 *      thirty optional ones. It answers "how much of this actually matters"
 *      before the seller starts scrolling, and it turns green the moment the
 *      listing is publishable, which is the only threshold that matters.
 *   2. Every section is numbered "01 / 05" in its head. A numbered section is
 *      a landmark; an unnumbered one is more form.
 *   3. Each section head states in one line what the section is for, so a
 *      seller can skip "Highlights & specifications" with confidence rather
 *      than reading four fields to discover it is optional.
 *
 * The photo grid was rebuilt around the fact that photos are the single
 * highest-leverage thing on a listing: the tiles are large, the first one is
 * marked as the cover (it is what a buyer sees in search), and upload state is
 * drawn ON the tile it belongs to rather than as a sentence somewhere below.
 *
 * WHAT ELSE THIS SCREEN ALREADY FIXED, AND STILL DOES:
 *
 *   - VALIDATION. It used to be a chain of `Alert.alert` calls that reported one
 *     problem at a time — and on web, where Alert is a no-op, reported nothing
 *     at all: tapping Save on an invalid form did visibly nothing. Errors are
 *     now inline, per field, all at once, and the form scrolls to the first one.
 *   - IMAGE UPLOADS. Five images were uploaded in a sequential loop with no
 *     progress; a failure on image 4 discarded the three already uploaded and
 *     failed the whole save, so retrying re-uploaded everything. Successful
 *     uploads are now cached by URI, so a retry only sends what is missing, and
 *     progress is visible per image.
 *   - PERMISSIONS. `launchImageLibraryAsync` was called without ever requesting
 *     or checking permission; a denial just returned `canceled`, which looked
 *     identical to the user backing out. Permission is now requested, and a
 *     permanent denial explains how to fix it in Settings.
 *   - Camera capture is offered alongside the library.
 *   - Leaving with unsaved edits asks first.
 *   - Save is blocked (with an explanation) while offline rather than failing
 *     after a 15-second timeout.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, Keyboard, Linking, Platform,
  Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@krushisarva/shared/context/AuthContext';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';
import api, { safeErrorMessage } from '@krushisarva/shared/services/api';
import { compressImage } from '@krushisarva/shared/utils/mediaCompressor';
import { DISTRICT_LIST, getTalukas, SELLING_SCOPES } from '@krushisarva/shared/constants/locations';
import PincodeLocationStatus from '@krushisarva/shared/components/PincodeLocationStatus';
import { usePincodeAutofill } from '@krushisarva/shared/hooks/usePincodeLocation';
import { matchDistrict, sanitizePincode, PINCODE_INPUT_MAX_LENGTH } from '@krushisarva/shared/utils/pincode';
import { canonicalDistrict, canonicalTaluka } from '../utils/businessProfile';
import {
  attachParams, carriedOffer, firstErrorKey, INT_MAX, mergeFieldErrors, pickAttachTarget,
  serverFieldErrors, TEXT_MAX, validateProductForm,
} from '../utils/productForm';
import { SUBCATEGORIES_MAP } from '@krushisarva/shared/constants/categories';

import { C, E, R, SP, T, alpha, useResponsive } from '../theme';
import { useNetwork } from '../hooks/useNetwork';
import useUnsavedChanges from '../hooks/useUnsavedChanges';
import {
  Screen, ActionBar, Button, IconButton, Field, TextField, CharCount, KeyboardAwareScroll,
  Chip, ChipGroup, OptionRow, FormSection, SelectSheet, InlineNotice,
  Card, ProgressBar, Badge,
  useConfirm, useToast,
} from '../components/ui';

/** The PIN code's village picker, in this app's SelectSheet. */
function VillageSheet({ title, items, selected, onSelect, placeholder, disabled }) {
  return (
    <SelectSheet
      title={title} items={items} value={selected} onChange={onSelect}
      placeholder={placeholder} disabled={disabled}
    />
  );
}

/**
 * The same picker, locked while a save runs. PincodeLocationStatus renders the
 * picker it is given and passes it no `disabled`, so the lock is bound here
 * instead — picking a village writes district/taluka/village into the form, and
 * the save is working from the values it read when Save was tapped.
 */
const LockedVillageSheet = (props) => <VillageSheet {...props} disabled />;

const UNITS = ['kg', 'quintal', 'gram', 'litre', 'ml', 'piece', 'bag', 'packet', 'bundle', 'acre', 'dozen'];
const MAX_IMAGES = 5;
const MAX_NAME = 120;
const MAX_DESC = 2000;
/** Digits in the largest stock / minimum order the API stores. */
const INT_DIGITS = String(INT_MAX).length;
/** Sections in the form, in scroll order. Drives the "01 / 05" counters. */
const TOTAL_SECTIONS = 5;

/**
 * The fields that decide whether this listing can go live at all. The progress
 * meter counts ONLY these — a meter that also counted `manufacturer` and
 * `harvestDate` would sit at 40% on a perfectly publishable listing and read
 * as "you are not done".
 *
 * IT BRANCHES ON MODE. In `attach` and `edit` the category and the name come
 * from the catalog row, so counting them in a 5-of-5 meter would leave a
 * complete offer permanently showing 3/5 — the meter would be reporting on
 * fields the seller cannot even see, let alone fill.
 */
function requiredProgress(form, mode) {
  const checks = mode !== 'create'
    ? [
        Number(form.price) > 0,
        form.stock.trim() !== '' && Number(form.stock) >= 0,
        !!form.district,
      ]
    : [
        !!form.categoryId,
        form.name.trim().length >= 3,
        Number(form.price) > 0,
        form.stock.trim() !== '' && Number(form.stock) >= 0,
        !!form.district,
      ];
  const done = checks.filter(Boolean).length;
  return { done, total: checks.length, percent: Math.round((done / checks.length) * 100) };
}

// ── Validation ───────────────────────────────────────────────────────────────

// The rules live in ../utils/productForm (validateProductForm), next to the
// API's limits they mirror, where they are unit-tested.

// ── Edit diff ────────────────────────────────────────────────────────────────

/**
 * The offer fields an edit can change, as the API stores them. Empty text is
 * `null`, so "the seller cleared it" and "it was never set" compare equal and a
 * cleared field goes to the server as null (JSON drops `undefined`, and the
 * server keeps any key it does not receive). Stock is not here: it is sent with
 * its own expectedStockQty guard.
 */
function offerFields(f) {
  const str = (v) => String(v ?? '').trim();
  const text = (v) => str(v) || null;
  const num = (v, fallback) => (str(v) ? Number(v) : fallback);
  return {
    sellingPrice: num(f.price, null),
    mrp: num(f.mrp, null),
    minOrderQty: num(f.moq, 1),
    dispatchSlaDays: num(f.dispatchSla, 2),
    sellerSku: text(f.sellerSku),
    sellScope: f.sellScope,
    district: text(f.district),
    taluka: text(f.taluka),
    village: text(f.village),
    state: text(f.state),
    harvestDate: text(f.harvestDate),
  };
}

/** Only the offer fields that differ from what the screen loaded. */
function offerDiff(form, loaded) {
  const now = offerFields(form);
  const was = offerFields(loaded);
  const patch = {};
  Object.keys(now).forEach((k) => { if (now[k] !== was[k]) patch[k] = now[k]; });
  return patch;
}

// ── Image tile ───────────────────────────────────────────────────────────────

/**
 * One photo. Upload state is drawn on the tile — a scrim plus a spinner while
 * it uploads, a red scrim plus a warning glyph when it failed — so a seller
 * can see *which* of five photos is the problem. The first tile is marked
 * "Cover", because that is the one that appears in buyer search results and
 * nothing else in the UI ever said so.
 */
function ImageTile({
  uri, onRemove, removeDisabled, status, label, isCover, coverLabel, uploadingLabel, failedLabel,
}) {
  const uploading = status === 'uploading';
  const failed = status === 'failed';

  return (
    <View
      style={s.imgWrap}
      accessible
      accessibilityLabel={[
        isCover ? coverLabel : null,
        uploading ? uploadingLabel : null,
        failed ? failedLabel : null,
      ].filter(Boolean).join('. ') || undefined}
    >
      <Image
        source={{ uri }}
        style={s.imgThumb}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        accessible={false}
      />

      {uploading || failed ? (
        <View style={[s.imgOverlay, failed && { backgroundColor: alpha(C.dangerBold, 0.62) }]}>
          {uploading
            ? <ActivityIndicator color={C.onBrand} />
            : <Ionicons name="alert-circle" size={26} color={C.onBrand} />}
        </View>
      ) : null}

      {isCover && !uploading && !failed ? (
        <View style={s.imgCover} importantForAccessibility="no">
          <Text style={s.imgCoverTxt} numberOfLines={1}>{coverLabel}</Text>
        </View>
      ) : null}

      <IconButton
        icon="close"
        size={16}
        color={C.onBrand}
        background={C.text}
        onPress={onRemove}
        disabled={removeDisabled}
        accessibilityLabel={label}
        style={s.imgRemove}
        buttonStyle={s.imgRemoveBtn}
      />
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function AddProductScreen({ route, navigation }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const toast = useToast();
  const confirm = useConfirm();
  const { isOffline } = useNetwork();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();

  // ── THREE MODES, not two ───────────────────────────────────────────────────
  // The screen used to know only `create` and `edit`, derived from a single
  // `route.params.product`. There was no state for "a catalog product that
  // exists and is NOT mine", which is the normal case in a multi-seller
  // marketplace and the one that must not create a second `products` row.
  //
  //   create → the seller searched, found nothing, is proposing a NEW catalog
  //            entry. Sends TWO payloads: catalog first, then the offer.
  //   attach → the seller picked an existing catalog product + pack size. Sends
  //            ONE payload: the offer. No `products` row is created.
  //   edit   → the seller is changing THEIR OWN offer. Sends a PARTIAL PATCH of
  //            offer fields only.
  const catalogProduct = route.params?.catalogProduct || null;
  const catalogVariant = route.params?.variant || null;
  const existingListing = route.params?.listing || null;
  const editProduct = route.params?.product || null;
  const prefill = route.params?.prefill || null;

  const mode = route.params?.intent === 'attach'
    ? (existingListing ? 'edit' : 'attach')
    : (editProduct ? 'edit' : 'create');
  const isEdit = mode === 'edit';
  const isAttach = mode === 'attach';
  // Only `create` edits the shared catalog row. `attach` and `edit` send the
  // offer alone, so the catalog fields are not shown there: an edit used to show
  // them editable, drop them from the request, and still say "Listing updated".
  const isCreate = mode === 'create';
  // In edit mode the offer values come from the listing when we have one, and
  // from the flattened legacy product shape otherwise (MyProducts still sends
  // that for older rows). A create that the duplicate gate turned into an
  // attach brings the offer the seller had already typed (`offer`).
  const carriedOfferParam = route.params?.offer || null;
  const offerSource = existingListing || editProduct || carriedOfferParam;
  const listingId = existingListing?.id || editProduct?.listingId || null;
  const variantId = catalogVariant?.id || editProduct?.variantId || null;

  // ── Form state ─────────────────────────────────────────────────────────────
  // Profile location pre-fills a NEW offer only. On an edit it showed the
  // seller's home taluka/village for an offer that has none.
  const profile = isEdit ? null : user;
  const [form, setForm] = useState(() => ({
    categoryId: catalogProduct?.categoryId || editProduct?.categoryId || prefill?.categoryId || '',
    subcategory: editProduct?.subcategory || '',
    name: catalogProduct?.name || editProduct?.name || prefill?.name || '',
    desc: editProduct?.description || '',
    price: (offerSource?.sellingPrice ?? offerSource?.price)?.toString() || '',
    mrp: offerSource?.mrp?.toString() || '',
    unit: catalogVariant?.unit || editProduct?.unit || 'kg',
    stock: (offerSource?.stockQty ?? offerSource?.stock)?.toString() || '',
    moq: offerSource?.minOrderQty?.toString() || '1',
    tags: editProduct?.tags?.join(', ') || '',
    harvestDate: offerSource?.harvestDate || '',
    brand: catalogProduct?.brand || editProduct?.brand || '',
    manufacturer: catalogProduct?.manufacturer || editProduct?.manufacturer || '',
    countryOfOrigin: editProduct?.countryOfOrigin || 'India',
    district: offerSource?.district || profile?.district || '',
    taluka: offerSource?.taluka || profile?.taluka || '',
    village: offerSource?.village || profile?.village || '',
    // Geography is an OFFER property. It used to be hard-coded onto the PRODUCT
    // payload as `state: 'Maharashtra'`, which is wrong twice over: it is not a
    // catalog field, and it is not always Maharashtra.
    state: offerSource?.state || user?.state || 'Maharashtra',
    sellScope: offerSource?.sellScope || 'district',
    dispatchSla: (offerSource?.dispatchSlaDays ?? 2).toString(),
    sellerSku: offerSource?.sellerSku || '',
    gtin: prefill?.gtin || '',
  }));

  // The offer as this screen loaded it (useRef keeps the first render's form).
  // An edit sends only what differs from it — see offerDiff.
  const loadedForm = useRef(form);

  const [highlights, setHighlights] = useState(() => (
    editProduct?.highlights?.length ? [...editProduct.highlights] : ['']
  ));

  const [specPairs, setSpecPairs] = useState(() => {
    const specs = editProduct?.specifications;
    if (specs && typeof specs === 'object' && Object.keys(specs).length > 0) {
      return Object.entries(specs).map(([k, v]) => ({ key: k, value: String(v) }));
    }
    return [{ key: '', value: '' }];
  });

  // The stock this screen loaded. stockQty is the AVAILABLE count and orders
  // take units off it while the screen is open, so an edit sends stock only when
  // the seller changed it, and says what it changed it from.
  const loadedStock = useRef((offerSource?.stockQty ?? offerSource?.stock)?.toString() || '');

  const [images, setImages] = useState(() => editProduct?.images || carriedOfferParam?.images || []); // remote urls
  const [localImgs, setLocalImgs] = useState([]);                        // [{ uri }]

  const [clientErrors, setErrors] = useState({});
  // Fields a 400 from the API named. Shown until the seller edits that field.
  const [serverErrors, setServerErrors] = useState({});
  const errors = useMemo(() => mergeFieldErrors(clientErrors, serverErrors), [clientErrors, serverErrors]);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  // `saving` state cannot gate re-entry on its own: two taps inside one frame
  // both read the pre-render value, and the second would upload the photos and
  // POST the product again. The ref flips synchronously, so it does.
  const savingRef = useRef(false);
  const [uploadState, setUploadState] = useState({});   // uri -> 'uploading'|'failed'
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total }

  // Successful uploads survive a failed save, so a retry re-sends only what is
  // still missing instead of paying for every image again.
  const uploadedCache = useRef(new Map());              // localUri -> remote url

  // ── Categories ─────────────────────────────────────────────────────────────
  const [categories, setCategories] = useState([]);
  const [catsLoading, setCatsLoading] = useState(true);
  const [catsError, setCatsError] = useState(null);

  const fetchCategories = useCallback(async () => {
    setCatsLoading(true);
    setCatsError(null);
    try {
      const { data } = await api.get('/agristore/categories');
      const listRaw = data?.data ?? data ?? [];
      setCategories(Array.isArray(listRaw) ? listRaw : []);
    } catch (e) {
      setCatsError({ message: safeErrorMessage(e, t('products.catsError')) });
    } finally {
      setCatsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    navigation.setOptions({
      title: isEdit ? t('products.updateProduct') : t('products.listProduct'),
    });
    fetchCategories();
  }, [fetchCategories, isEdit, navigation, t]);

  // ── Field updates ──────────────────────────────────────────────────────────
  // A carried-over offer is unsaved work from the first render.
  const dirtyRef = useRef(!!carriedOfferParam);

  const setField = useCallback((key) => (value) => {
    dirtyRef.current = true;
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Changing the parent invalidates the child selection.
      if (key === 'categoryId' && value !== prev.categoryId) next.subcategory = '';
      if (key === 'district' && value !== prev.district) next.taluka = '';
      return next;
    });
    // Clear a field's error the moment the user edits it — leaving red text
    // under a field they just fixed reads as "still wrong".
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  // PIN code → district / taluka / village. Only a helper: an offer stores no
  // PIN. The district list is Maharashtra-only with the older names
  // (Osmanabad), so the lookup's names are mapped onto it, and a PIN outside
  // Maharashtra leaves the location fields alone.
  const [pincode, setPincode] = useState('');
  const applyPin = useCallback((patch) => {
    // The district NAME alone can't tell states apart — Bihar has an
    // Aurangabad too, and canonicalDistrict would map it onto Maharashtra's.
    if (patch.state && patch.state !== 'Maharashtra') return;
    dirtyRef.current = true;
    setForm((prev) => {
      let next = prev;
      if ('district' in patch) {
        const district = canonicalDistrict(patch.district);
        if (patch.district && !district) return prev;
        if (district !== prev.district) next = { ...next, district, taluka: '' };
      }
      if ('taluka' in patch) {
        next = { ...next, taluka: patch.taluka ? canonicalTaluka(next.district, patch.taluka) : '' };
      }
      if ('village' in patch) next = { ...next, village: patch.village };
      return next;
    });
    if (patch.district) setErrors((prev) => (prev.district ? { ...prev, district: undefined } : prev));
  }, []);
  const pinValues = useMemo(() => ({
    // Fixed: the district list is Maharashtra-only. Mapped so a PIN from
    // another state arrives in the patch as its state, and applyPin drops it.
    state: 'Maharashtra',
    // Compared in the lookup's own names, so "Osmanabad" isn't read as a
    // different district from "Dharashiv".
    district: matchDistrict('Maharashtra', form.district) || form.district,
    taluka: form.taluka,
    village: form.village,
  }), [form.district, form.taluka, form.village]);
  const pin = usePincodeAutofill({
    pincode,
    values: pinValues,
    fields: { state: 'state', district: 'district', taluka: 'taluka', village: 'village' },
    strict: ['district', 'taluka'],
    onChange: applyPin,
  });
  const pinOutsideState = pin.status === 'found' && !!pin.summary?.state
    && pin.summary.state !== 'Maharashtra';

  // Live re-validation, but only after the first submit attempt. Validating
  // while someone types their first character is hostile.
  useEffect(() => {
    if (!submitted) return;
    setErrors(validateProductForm(form, t, mode));
  }, [form, submitted, t, mode]);

  const isDirty = dirtyRef.current || localImgs.length > 0
    || images.length !== (editProduct?.images?.length || 0);

  const confirmDiscard = useCallback(() => confirm({
    title: t('products.discardTitle', 'Discard changes?'),
    message: t('products.discardMsg', 'Your edits to this listing will be lost.'),
    confirmLabel: t('products.discard', 'Discard'),
    cancelLabel: t('products.keepEditing', 'Keep editing'),
    destructive: true,
    icon: 'trash-outline',
  }), [confirm, t]);

  const { allowNext } = useUnsavedChanges(isDirty && !saving, confirmDiscard);

  // ── Scroll-to-error ────────────────────────────────────────────────────────
  // Each field is measured against the ScrollView's content. A field's own
  // layout y is relative to its parent — the section card, or the price/stock
  // row — so scrolling to it landed near the top of the form, not on the field.
  const scrollRef = useRef(null);
  const fieldRefs = useRef({});
  const refFor = useMemo(() => {
    const cache = {};
    return (key) => {
      if (!cache[key]) cache[key] = (node) => { fieldRefs.current[key] = node; };
      return cache[key];
    };
  }, []);
  const [scrollTarget, setScrollTarget] = useState(null);

  const scrollToFirstError = useCallback((errs) => {
    const first = firstErrorKey(errs);
    if (first) setScrollTarget({ key: first, at: Date.now() });
  }, []);

  // Runs after the errors (and the notice above the form) have rendered, so the
  // measurement includes the space they take.
  useEffect(() => {
    if (!scrollTarget) return undefined;
    const frame = requestAnimationFrame(() => {
      const node = fieldRefs.current[scrollTarget.key];
      if (!node) return;
      if (Platform.OS === 'web') {
        // The document scrolls on web (see App.js), not the ScrollView.
        node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        return;
      }
      const scroller = scrollRef.current;
      const inner = scroller?.getInnerViewRef?.();
      if (!inner || typeof node.measureLayout !== 'function') return;
      node.measureLayout(
        inner,
        (_x, y) => scroller.scrollTo({ y: Math.max(0, y - 24), animated: true }),
        () => {},
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollTarget]);

  // ── Images ─────────────────────────────────────────────────────────────────
  const allImages = useMemo(() => [
    ...images.map((u) => ({ uri: u, local: false })),
    ...localImgs.map((img) => ({ uri: img.uri, local: true })),
  ], [images, localImgs]);

  const remainingSlots = MAX_IMAGES - allImages.length;

  /**
   * Ask for permission, and tell the user what to do when the OS will no longer
   * show the prompt (`canAskAgain: false`) — otherwise the picker silently does
   * nothing forever and looks like a broken button.
   */
  const ensurePermission = useCallback(async (kind) => {
    const request = kind === 'camera'
      ? ImagePicker.requestCameraPermissionsAsync
      : ImagePicker.requestMediaLibraryPermissionsAsync;

    const result = await request();
    if (result.granted) return true;

    if (result.canAskAgain === false) {
      const open = await confirm({
        title: t('products.permissionTitle', 'Permission needed'),
        message: kind === 'camera'
          ? t('products.cameraDeniedMsg', 'Allow camera access in Settings to photograph your products.')
          : t('products.photosDeniedMsg', 'Allow photo access in Settings to upload product images.'),
        confirmLabel: t('products.openSettings', 'Open Settings'),
        cancelLabel: t('cancel'),
        icon: 'lock-closed-outline',
      });
      if (open) Linking.openSettings?.().catch(() => {});
    } else {
      toast.warning(
        kind === 'camera'
          ? t('products.cameraDenied', 'Camera access was denied.')
          : t('products.photosDenied', 'Photo access was denied.'),
      );
    }
    return false;
  }, [confirm, t, toast]);

  const addAssets = useCallback((assets) => {
    if (!assets?.length) return;
    dirtyRef.current = true;
    setLocalImgs((prev) => {
      const room = MAX_IMAGES - (images.length + prev.length);
      return [...prev, ...assets.slice(0, Math.max(0, room)).map((a) => ({ uri: a.uri }))];
    });
  }, [images.length]);

  const pickFromLibrary = useCallback(async () => {
    if (remainingSlots <= 0) {
      toast.warning(t('products.limitMsg'));
      return;
    }
    if (!(await ensurePermission('library'))) return;

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: remainingSlots,
      });
      if (!result.canceled) addAssets(result.assets);
    } catch (e) {
      toast.error(t('products.pickerError', 'Could not open your photos. Please try again.'));
    }
  }, [remainingSlots, ensurePermission, addAssets, toast, t]);

  const takePhoto = useCallback(async () => {
    if (remainingSlots <= 0) {
      toast.warning(t('products.limitMsg'));
      return;
    }
    if (!(await ensurePermission('camera'))) return;

    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.8 });
      if (!result.canceled) addAssets(result.assets);
    } catch (e) {
      toast.error(t('products.cameraError', 'Could not open the camera. Please try again.'));
    }
  }, [remainingSlots, ensurePermission, addAssets, toast, t]);

  const removeImage = useCallback((uri, isLocal) => {
    dirtyRef.current = true;
    if (isLocal) {
      setLocalImgs((prev) => prev.filter((img) => img.uri !== uri));
      uploadedCache.current.delete(uri);
      setUploadState((prev) => {
        const next = { ...prev };
        delete next[uri];
        return next;
      });
    } else {
      setImages((prev) => prev.filter((u) => u !== uri));
    }
  }, []);

  // ── Highlights / specs ─────────────────────────────────────────────────────
  const updateHighlight = useCallback((i, value) => {
    dirtyRef.current = true;
    setHighlights((prev) => prev.map((h, idx) => (idx === i ? value : h)));
  }, []);

  const updateSpec = useCallback((i, key, value) => {
    dirtyRef.current = true;
    setSpecPairs((prev) => prev.map((pair, idx) => (idx === i ? { ...pair, [key]: value } : pair)));
  }, []);

  // ── Save ───────────────────────────────────────────────────────────────────
  const uploadOne = useCallback(async (uri) => {
    const cached = uploadedCache.current.get(uri);
    if (cached) return cached;

    setUploadState((prev) => ({ ...prev, [uri]: 'uploading' }));
    try {
      const { base64 } = await compressImage(uri);
      const { data } = await api.post('/upload/image', { base64 }, { timeout: 60_000 });
      const url = data?.data?.url;
      if (!url) throw new Error('Upload returned no URL');
      uploadedCache.current.set(uri, url);
      setUploadState((prev) => {
        const next = { ...prev };
        delete next[uri];
        return next;
      });
      return url;
    } catch (e) {
      setUploadState((prev) => ({ ...prev, [uri]: 'failed' }));
      throw e;
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    setSubmitted(true);
    const errs = validateProductForm(form, t, mode);
    setErrors(errs);
    setServerErrors({});

    if (Object.keys(errs).some((k) => errs[k])) {
      toast.error(t('products.fixErrors', 'Please fix the highlighted fields.'));
      scrollToFirstError(errs);
      return;
    }

    if (isOffline) {
      toast.warning(t('common.offlineAction', 'You are offline. Reconnect to save this.'));
      return;
    }

    // FROM HERE THE FORM IS FROZEN. Everything below works from the photos and
    // the values read now, and five uploads on a village connection can take
    // minutes — so an edit made meanwhile would be silently dropped, and a photo
    // removed mid-upload would still be uploaded and published. The form body is
    // made inert while `saving` (see the wrapper in the render); the keyboard is
    // dismissed here because pointer events cannot blur an input that already
    // has focus.
    Keyboard.dismiss();
    savingRef.current = true;
    setSaving(true);
    // Set once POST /catalog/products has succeeded: { product, variant }.
    let createdCatalog = null;
    try {
      // Upload sequentially — the compressor is memory-hungry and five parallel
      // base64 payloads is how low-end devices get killed by the OS.
      const uploaded = [];
      const pending = localImgs.filter((img) => !uploadedCache.current.has(img.uri));
      if (pending.length) setUploadProgress({ done: 0, total: pending.length });

      for (const img of localImgs) {
        const wasCached = uploadedCache.current.has(img.uri);
        uploaded.push(await uploadOne(img.uri));
        if (!wasCached) {
          setUploadProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
        }
      }
      setUploadProgress(null);

      const specsObj = {};
      specPairs.forEach(({ key, value }) => {
        if (key.trim() && value.trim()) specsObj[key.trim()] = value.trim();
      });

      const highlightList = highlights.map((h) => h.trim()).filter(Boolean);
      const tagList = form.tags.trim()
        ? form.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        : undefined;

      const allImages = [...images, ...uploaded];

      // ── ONE FLAT PAYLOAD BECOMES TWO ─────────────────────────────────────
      // The old payload mixed catalog keys (name, description, brand,
      // specifications, images) with offer keys (price, stock, district) and
      // POSTed them to a single endpoint that wrote them all onto one row.
      // Post-split those belong to different tables with different owners: the
      // catalog row is SHARED by every seller of the product, the offer is this
      // Kendra's alone.
      const catalogPayload = {
        categoryId: form.categoryId,
        subcategory: form.subcategory || undefined,
        name: form.name.trim(),
        description: form.desc.trim() || undefined,
        tags: tagList,
        images: allImages,
        brand: form.brand.trim() || undefined,
        manufacturer: form.manufacturer.trim() || undefined,
        countryOfOrigin: form.countryOfOrigin.trim() || undefined,
        highlights: highlightList.length ? highlightList : undefined,
        specifications: Object.keys(specsObj).length ? specsObj : undefined,
        // NO `sku` here. The seller's stock code is private ("Buyers never see
        // it") and ProductVariant.sku is a SHARED catalog field — it goes back
        // out on /catalog/search, /products/:id/offers and the buy box, so every
        // other Kendra and every buyer would read this Kendra's internal code.
        // It belongs on the offer alone, as `sellerSku` below.
        variants: [{
          unit: form.unit,
          attributes: form.unit ? { packSize: form.unit } : {},
          gtin: form.gtin.trim() || undefined,
        }],
      };

      const offerPayload = {
        sellingPrice: Number(form.price),
        mrp: form.mrp.trim() ? Number(form.mrp) : undefined,
        stockQty: Number(form.stock),
        minOrderQty: form.moq.trim() ? Number(form.moq) : 1,
        dispatchSlaDays: form.dispatchSla.trim() ? Number(form.dispatchSla) : 2,
        sellerSku: form.sellerSku.trim() || undefined,
        sellScope: form.sellScope,
        district: form.district || undefined,
        taluka: form.taluka || undefined,
        village: form.village.trim() || undefined,
        // Geography belongs to the OFFER, and it is whatever the seller set —
        // never a hard-coded 'Maharashtra' stamped onto the product.
        state: form.state || undefined,
        harvestDate: form.harvestDate.trim() || undefined,
        // The seller's own photos of THEIR stock. Deliberately separate from the
        // shared catalog imagery in attach mode: uploading a photo must not
        // silently rewrite what every other Kendra's buyers see.
        images: isAttach ? allImages : [],
      };

      if (isEdit) {
        // Partial patch of OFFER fields only. The old edit sent the full payload
        // via PUT and the backend wrote any key present — so on a shared catalog
        // row, one Kendra changing their price would have overwritten the name,
        // description, specs and images FOR EVERY OTHER SELLER.
        //
        // And only the fields the seller CHANGED. Sending the whole offer wrote
        // the screen's copy over the real one: `images: []` wiped the offer's
        // photos, and a value the screen never received (dispatch days, MOQ,
        // reach from Catalog Search) went back as its default. Photos are never
        // sent — this screen has no editor for the offer's own photos.
        const patch = offerDiff(form, loadedForm.current);
        const stockChanged = form.stock.trim() !== loadedStock.current;
        const stockQty = Number(form.stock);
        if (listingId) {
          if (stockChanged) {
            patch.stockQty = stockQty;
            if (loadedStock.current !== '') patch.expectedStockQty = Number(loadedStock.current);
          }
          // Nothing changed → nothing to write (and no catalog cache flush).
          if (Object.keys(patch).length) await api.patch(`/agristore/listings/${listingId}`, patch);
        } else {
          // Legacy row with no listing id yet — the shim resolves it by product.
          // Unchanged keys are undefined and drop out; cleared ones are null.
          await api.put(`/agristore/seller/products/${editProduct.id}`, {
            price: patch.sellingPrice,
            mrp: patch.mrp,
            stock: stockChanged ? stockQty : undefined,
            minOrderQty: patch.minOrderQty,
            sellScope: patch.sellScope,
            district: patch.district,
            taluka: patch.taluka,
            village: patch.village,
            state: patch.state,
            harvestDate: patch.harvestDate,
          });
        }
      } else if (isAttach) {
        // NO products row is created. This is the whole point of the mode.
        await api.post('/agristore/listings', { ...offerPayload, variantId });
      } else {
        // New catalog entry: catalog first (server-side duplicate gate runs here
        // and can 409), then the offer against the variant it just created.
        const { data } = await api.post('/agristore/catalog/products', catalogPayload);
        const created = data?.data;
        const newVariant = created?.variants?.[0];
        if (!newVariant?.id) throw new Error(t('products.variantMissing', 'The product was created but its pack size was not. Open it from My Products and set your price.'));
        createdCatalog = { product: created, variant: newVariant };
        await api.post('/agristore/listings', { ...offerPayload, variantId: newVariant.id, images: allImages });
      }

      dirtyRef.current = false;
      allowNext();
      toast.success(
        isEdit
          ? t('products.updated', 'Listing updated')
          // An offer on a product still in review goes live when it is approved.
          : isAttach && catalogProduct?.status !== 'PENDING_QC'
            ? t('products.offerAdded', 'Your offer is live')
            : t('products.createdPendingQc', 'Sent for review — buyers will see it once KrushiSarva approves it'),
      );
      navigation.goBack();
    } catch (e) {
      setUploadProgress(null);

      // Stock moved while the screen was open (orders came in). Show the live
      // number in the field; the seller checks it and saves again.
      const liveStock = e?.response?.data?.error?.details?.currentStockQty;
      if (e?.response?.status === 409 && typeof liveStock === 'number') {
        loadedStock.current = String(liveStock);
        setForm((prev) => ({ ...prev, stock: String(liveStock) }));
        toast.error(safeErrorMessage(e, t('products.saveError')));
        return;
      }

      // 409 from the duplicate gate is not a failure — it is the flow working.
      // The server hands back the catalog product the seller should attach to,
      // so offer that instead of just showing an error.
      if (e?.response?.status === 409 && e?.response?.data?.error?.details?.productId) {
        const details = e.response.data.error.details;
        // The product the server named, in the pack this seller chose — not
        // candidates[0] and its first pack, which put a bag price on the 1 kg pack.
        const { product, variant } = pickAttachTarget(details, form.unit);
        const name = product?.name || t('products.dupFallbackName', 'this product');
        if (!variant) {
          const find = await confirm({
            title: t('products.dupPickPackTitle', 'Choose your pack size'),
            message: t('products.dupPickPackMsg', {
              name,
              defaultValue: '“{{name}}” is already in the catalogue. Find it there and choose the pack size you sell.',
            }),
            confirmLabel: t('products.dupFindInCatalogue', 'Find in catalogue'),
            cancelLabel: t('cancel', 'Cancel'),
            icon: 'git-merge-outline',
          });
          if (find) {
            allowNext();
            navigation.navigate('CatalogSearch');
          }
          return;
        }
        const ok = await confirm({
          title: t('products.dupTitle', 'This product is already listed'),
          message: t('products.dupMsg', {
            name,
            defaultValue: `“${name}” is already in the catalogue. Add your price and stock to it instead of creating a duplicate.`,
          }),
          confirmLabel: t('products.dupUseExisting', 'Use the existing product'),
          cancelLabel: t('cancel', 'Cancel'),
          icon: 'git-merge-outline',
        });
        if (ok) {
          // The offer goes with the seller: price, stock, MOQ, location and the
          // photos already uploaded. The attach form used to open empty.
          const uploadedUrls = localImgs.map((img) => uploadedCache.current.get(img.uri)).filter(Boolean);
          allowNext();
          navigation.replace('AddProduct', {
            ...attachParams(product, variant),
            offer: carriedOffer(form, [...images, ...uploadedUrls]),
          });
        }
        return;
      }

      // The catalog row was created but the offer was not — a 400, or a timeout
      // on a weak network. Carry on as an attach to that row, so the next Save
      // sends only the offer. It used to send the catalog again, hit the
      // duplicate gate on the seller's OWN new product, and replace the form,
      // losing the price, stock, location and photos.
      if (createdCatalog) {
        navigation.setParams(attachParams(createdCatalog.product, createdCatalog.variant));
      }

      // A 400 names the fields the API rejected: show them on the form.
      const fieldErrs = serverFieldErrors(e, t);
      if (Object.keys(fieldErrs).length) {
        setServerErrors(fieldErrs);
        toast.error(t('products.fixErrors', 'Please fix the highlighted fields.'));
        scrollToFirstError(fieldErrs);
        return;
      }

      // The barcode belongs to another seller's product that is still in review.
      if (e?.response?.status === 409 && e?.response?.data?.error?.details?.inReview) {
        toast.error(t('products.dupInReview', 'A product with this barcode is waiting for KrushiSarva review. You can add your offer to it once it is approved.'));
        return;
      }

      const message = createdCatalog
        ? t('products.offerNotSaved', 'Your product was added, but your price and stock were not saved yet. Tap Save to try again.')
        : safeErrorMessage(e, t('products.saveError'));
      toast.error(message);
      // A validation rejection from the server is about the fields, not the
      // network — point the seller back at the form.
      if (e?.response?.status === 400 || e?.response?.status === 422) {
        scrollRef.current?.scrollTo({ y: 0, animated: true });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    form, t, toast, confirm, isOffline, scrollToFirstError, localImgs, uploadOne, specPairs,
    highlights, images, isEdit, isAttach, mode, editProduct, listingId, variantId,
    allowNext, navigation, catalogProduct,
  ]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.id, label: c.name })),
    [categories],
  );

  const subcategoryOptions = useMemo(() => {
    const cat = categories.find((c) => c.id === form.categoryId);
    return cat ? (SUBCATEGORIES_MAP[cat.name] || []) : [];
  }, [categories, form.categoryId]);

  const talukaOptions = useMemo(() => getTalukas(form.district), [form.district]);

  const failedUploads = Object.values(uploadState).filter((v) => v === 'failed').length;

  // Counted live so the meter moves as the seller types, not on submit.
  const progress = requiredProgress(form, mode);

  // Section numbering branches with the mode: in `attach` the two catalog
  // sections are not rendered at all, so leaving them in the count would number
  // the form 01, 03, 05 and claim five steps where there are three. `edit` also
  // drops the photos, which it never sends.
  const sectionSteps = isCreate
    ? { photos: 1, details: 2, pricing: 3, specs: 4, geo: 5 }
    : isAttach
      ? { photos: 1, details: null, pricing: 2, specs: null, geo: 3 }
      : { photos: null, details: null, pricing: 1, specs: null, geo: 2 };
  const totalSections = isCreate ? TOTAL_SECTIONS : isAttach ? 3 : 2;

  // The product being sold, for the banner. The legacy edit path has only the
  // flattened product row.
  const bannerProduct = catalogProduct || editProduct;

  return (
    <Screen edges={['left', 'right']} background={C.bg}>
      <KeyboardAwareScroll
        ref={scrollRef}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
        contentContainerStyle={[
          { padding: gutter, paddingBottom: SP.huge },
          isExpanded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* The whole form goes inert while a save runs — the save is working from
            the values and photos it read when Save was tapped, so an edit made
            now could not be honoured, and a removed photo would be published
            anyway. Touches pass through to the ScrollView, so the seller can
            still scroll and watch the per-photo progress; the action bar below is
            outside this wrapper and stays live. */}
        <View pointerEvents={saving ? 'none' : 'auto'} style={saving ? s.formSaving : null}>
          {/* ── Progress ── */}
          <Card style={s.progressCard}>
            <View style={s.progressTop}>
              <View style={{ flex: 1 }}>
                <Text style={s.progressTitle} numberOfLines={2}>
                  {isEdit
                    ? t('products.updateOffer', 'Update your offer')
                    : isAttach
                      ? t('products.sellThisProduct', 'Sell this product')
                      : t('products.listProduct', 'List a product')}
                </Text>
                <Text style={s.progressSub} numberOfLines={2}>
                  {progress.done === progress.total
                    ? t('products.readyToPublish', 'All required details are filled in.')
                    : t('products.requiredLeft', {
                        n: progress.total - progress.done,
                        defaultValue: '{{n}} required detail(s) still to fill in.',
                      })}
                </Text>
              </View>
              <Text style={[s.progressFig, progress.done === progress.total && { color: C.success }]}>
                {progress.done}
                <Text style={s.progressFigDim}> / {progress.total}</Text>
              </Text>
            </View>
            <ProgressBar
              value={progress.percent}
              color={progress.done === progress.total ? C.success : C.brand}
              label={t('products.requiredProgress', 'Required details completed')}
              style={{ marginTop: SP.lg }}
            />
          </Card>

          {/* ── Attach banner ──────────────────────────────────────────────
              In attach mode the seller is adding an OFFER to a product someone
              else may already sell. Naming it here — with the pack size and what
              the competition costs — is the difference between "fill in a form"
              and "you are about to compete with two other Kendras on this exact
              pack". Shown on an edit too: it names what is being edited now that
              the catalog fields are not on the form. */}
          {!isCreate && bannerProduct ? (
            <Card style={s.attachCard}>
              <View style={s.attachRow}>
                {bannerProduct.images?.[0] ? (
                  <Image
                    source={{ uri: bannerProduct.images[0] }}
                    style={s.attachImg}
                    resizeMode="cover"
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={[s.attachImg, s.attachImgEmpty]}>
                    <Ionicons name="leaf-outline" size={20} color={C.textMuted} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={s.attachName} numberOfLines={2}>{bannerProduct.name}</Text>
                  {catalogVariant?.packSize || catalogVariant?.unit ? (
                    <Text style={s.attachPack} numberOfLines={1}>
                      {catalogVariant.packSize || catalogVariant.unit}
                      {bannerProduct.brand ? ` · ${bannerProduct.brand}` : ''}
                    </Text>
                  ) : null}
                  {/* Attach only: on an edit offerCount includes this seller's
                      own offer, so "N other sellers" would count them. */}
                  {isAttach && catalogVariant?.offerCount > 0 ? (
                    <Text style={s.attachCompete} numberOfLines={1}>
                      {t('products.competingWith', {
                        count: catalogVariant.offerCount,
                        price: `₹${Number(catalogVariant.lowestPrice).toLocaleString('en-IN')}`,
                        defaultValue: `${catalogVariant.offerCount} other seller(s) · lowest ₹${catalogVariant.lowestPrice}`,
                      })}
                    </Text>
                  ) : null}
                </View>
              </View>
              <InlineNotice variant="info" icon="information-circle" style={{ marginTop: SP.md }}>
                {t(
                  'products.attachExplain',
                  'The name, description and photos of this product are shared with every seller — you cannot change them here. Set your price, stock and delivery details below.',
                )}
              </InlineNotice>
            </Card>
          ) : null}

          {mode === 'create' ? (
            <InlineNotice variant="info" icon="shield-checkmark" style={{ marginBottom: SP.lg }}>
              {t(
                'products.qcNotice',
                'New products are reviewed by KrushiSarva before buyers can see them. Your price and stock are saved now and go live on approval.',
              )}
            </InlineNotice>
          ) : null}

          {submitted && Object.values(errors).some(Boolean) ? (
            <InlineNotice variant="error" style={{ marginBottom: SP.lg }}>
              {t('products.fixErrors', 'Please fix the highlighted fields.')}
            </InlineNotice>
          ) : null}

          {/* ── Photos ── Not on an edit: the save never sends photos (sending
              the tiles here wiped the offer's own photos), so tiles that could
              be added or removed would be discarded on save. */}
          {isEdit ? null : (
          <FormSection
            icon="images-outline"
            title={isAttach ? t('products.yourPhotos', 'Your photos') : t('products.photos', 'Photos')}
            hint={isAttach
              ? t('products.yourPhotosHint', 'Optional. Photos of YOUR stock — they appear on your offer, not on the shared product page.')
              : t('products.photosHint')}
            step={sectionSteps.photos}
            total={totalSections}
          >
            <Field label={t('products.photosField')}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.imgRow}
                keyboardShouldPersistTaps="handled"
              >
                {allImages.map((img, i) => (
                  <ImageTile
                    key={img.uri}
                    uri={img.uri}
                    status={uploadState[img.uri]}
                    isCover={i === 0}
                    coverLabel={t('products.coverPhoto', 'Cover')}
                    uploadingLabel={t('products.uploading', 'Uploading')}
                    failedLabel={t('products.uploadFailedOne', 'Upload failed')}
                    onRemove={() => removeImage(img.uri, img.local)}
                    // A save already reads `localImgs`: removing a photo while
                    // photo 2 of 5 uploads would have uploaded and published the
                    // removed one anyway.
                    removeDisabled={saving}
                    label={t('products.removePhoto', 'Remove photo')}
                  />
                ))}

                {remainingSlots > 0 ? (
                  <>
                    <Pressable
                      onPress={pickFromLibrary}
                      // A photo added mid-save would not be in the payload.
                      disabled={saving}
                      accessibilityRole="button"
                      accessibilityLabel={t('products.addPhoto')}
                      accessibilityState={{ disabled: saving }}
                      accessibilityHint={t('products.addPhotoHint', {
                        n: remainingSlots,
                        defaultValue: '{{n}} more can be added',
                      })}
                      style={({ pressed }) => [s.imgAdd, pressed && { opacity: 0.7 }]}
                    >
                      <Ionicons name="images-outline" size={24} color={C.brandInk} />
                      <Text style={s.imgAddTxt}>{t('products.addPhoto')}</Text>
                    </Pressable>

                    {Platform.OS !== 'web' ? (
                      <Pressable
                        onPress={takePhoto}
                        disabled={saving}
                        accessibilityRole="button"
                        accessibilityLabel={t('products.takePhoto', 'Take photo')}
                        accessibilityState={{ disabled: saving }}
                        style={({ pressed }) => [s.imgAdd, pressed && { opacity: 0.7 }]}
                      >
                        <Ionicons name="camera-outline" size={24} color={C.brandInk} />
                        <Text style={s.imgAddTxt}>{t('products.takePhoto', 'Camera')}</Text>
                      </Pressable>
                    ) : null}
                  </>
                ) : null}
              </ScrollView>

              <View style={s.imgFoot}>
                <Badge
                  label={t('products.photoCount', {
                    n: allImages.length,
                    max: MAX_IMAGES,
                    defaultValue: '{{n}} of {{max}}',
                  })}
                  color={allImages.length > 0 ? C.brandInk : C.neutral}
                  icon="images"
                />
              </View>

              {failedUploads > 0 ? (
                <InlineNotice variant="error" style={{ marginTop: SP.md }}>
                  {t('products.uploadFailed', {
                    n: failedUploads,
                    defaultValue: '{{n}} photo(s) failed to upload. Save again to retry just those.',
                  })}
                </InlineNotice>
              ) : null}
            </Field>
          </FormSection>
          )}

          {/* ── Product details ── */}
          {/* CATALOG SECTION — create only. These fields belong to the shared
              `products` row; letting one seller edit them would rewrite what
              every other seller's buyers see. */}
          {isCreate ? (
          <FormSection
            icon="leaf-outline"
            title={t('products.productDetails')}
            hint={t('products.productNameHint')}
            step={sectionSteps.details}
            total={totalSections}
          >
            <Field
              label={t('products.category')}
              required
              error={errors.categoryId}
              ref={refFor('categoryId')}
            >
              <SelectSheet
                disabled={saving}
                title={t('products.selectCategoryTitle')}
                placeholder={t('products.selectCategory')}
                items={categoryOptions}
                value={form.categoryId}
                onChange={setField('categoryId')}
                loading={catsLoading}
                error={catsError}
                onRetry={fetchCategories}
                accessibilityLabel={t('products.category')}
              />
            </Field>

            {subcategoryOptions.length > 0 ? (
              <Field label={t('products.subcategory')} hint={t('products.subcategoryHint')}>
                <SelectSheet
                  disabled={saving}
                  title={t('products.selectSubcategoryTitle')}
                  placeholder={t('products.noneGeneral')}
                  items={subcategoryOptions}
                  value={form.subcategory}
                  onChange={setField('subcategory')}
                  clearLabel={t('products.noneGeneral')}
                  accessibilityLabel={t('products.subcategory')}
                />
              </Field>
            ) : null}

            <Field
              label={t('products.productName')}
              required
              hint={t('products.productNameHint')}
              error={errors.name}
              ref={refFor('name')}
            >
              <TextField
                editable={!saving}
                value={form.name}
                onChangeText={setField('name')}
                placeholder={t('products.productNamePlaceholder')}
                error={errors.name}
                maxLength={MAX_NAME}
                label={t('products.productName')}
              />
              <CharCount value={form.name} max={MAX_NAME} />
            </Field>

            <Field label={t('products.description')} hint={t('products.descHint')}>
              <TextField
                editable={!saving}
                value={form.desc}
                onChangeText={setField('desc')}
                placeholder={t('products.descPlaceholder')}
                multiline
                maxLength={MAX_DESC}
                label={t('products.description')}
              />
              <CharCount value={form.desc} max={MAX_DESC} />
            </Field>

            <Field label={t('products.searchTags')} hint={t('products.searchTagsHint')}>
              <TextField
                editable={!saving}
                value={form.tags}
                onChangeText={setField('tags')}
                placeholder={t('products.searchTagsPlaceholder')}
                autoCapitalize="none"
                label={t('products.searchTags')}
              />
            </Field>
          </FormSection>
          ) : null}

          {/* ── Pricing & stock ── OFFER fields. Always shown. */}
          <FormSection
            icon="pricetag-outline"
            title={t('products.pricingStock')}
            hint={t('products.mrpHint')}
            step={sectionSteps.pricing}
            total={totalSections}
          >
            <View style={s.pairRow}>
              <Field
                label={t('products.sellingPrice')}
                required
                error={errors.price}
                ref={refFor('price')}
                style={s.pairCell}
              >
                <TextField
                  editable={!saving}
                  value={form.price}
                  onChangeText={setField('price')}
                  placeholder="0"
                  keyboardType="decimal-pad"
                  error={errors.price}
                  prefix={<Text style={s.affixTxt}>₹</Text>}
                  label={t('products.sellingPrice')}
                />
              </Field>

              <Field
                label={t('products.mrp')}
                hint={errors.mrp ? undefined : t('products.mrpHint')}
                error={errors.mrp}
                ref={refFor('mrp')}
                style={s.pairCell}
              >
                <TextField
                  editable={!saving}
                  value={form.mrp}
                  onChangeText={setField('mrp')}
                  placeholder="0"
                  keyboardType="decimal-pad"
                  error={errors.mrp}
                  prefix={<Text style={s.affixTxt}>₹</Text>}
                  label={t('products.mrp')}
                />
              </Field>
            </View>

            {/* The unit is a property of the VARIANT (the pack), not of the
                offer — three Kendras selling the same 450 g pack must all be
                selling the same 450 g. In attach and edit it is shown, not chosen. */}
            {!isCreate ? (
              <Field label={t('products.pack', 'Pack size')} hint={t('products.packFixed', 'Set by the product — every seller of this pack sells the same size.')}>
                <View style={s.readOnlyRow}>
                  <Ionicons name="cube-outline" size={16} color={C.textMuted} />
                  <Text style={s.readOnlyTxt}>{catalogVariant?.packSize || form.unit}</Text>
                </View>
              </Field>
            ) : (
              <Field label={t('products.unit')} required hint={t('products.unitHint')}>
                <ChipGroup accessibilityLabel={t('products.unit')}>
                  {UNITS.map((u) => (
                    <Chip
                      disabled={saving}
                      key={u}
                      label={u}
                      selected={form.unit === u}
                      onPress={() => setField('unit')(u)}
                    />
                  ))}
                </ChipGroup>
              </Field>
            )}

            <View style={s.pairRow}>
              <Field
                label={t('products.stock')}
                required
                error={errors.stock}
                ref={refFor('stock')}
                style={s.pairCell}
              >
                <TextField
                  editable={!saving}
                  value={form.stock}
                  onChangeText={setField('stock')}
                  placeholder={t('products.availableQtyPlaceholder')}
                  keyboardType="number-pad"
                  maxLength={INT_DIGITS}
                  error={errors.stock}
                  suffix={<Text style={s.affixTxt}>{form.unit}</Text>}
                  label={t('products.stock')}
                />
              </Field>

              <Field
                label={t('products.minOrder')}
                hint={errors.moq ? undefined : t('products.minOrderHint')}
                error={errors.moq}
                ref={refFor('moq')}
                style={s.pairCell}
              >
                <TextField
                  editable={!saving}
                  value={form.moq}
                  onChangeText={setField('moq')}
                  placeholder="1"
                  keyboardType="number-pad"
                  maxLength={INT_DIGITS}
                  error={errors.moq}
                  label={t('products.minOrder')}
                />
              </Field>
            </View>

            <View style={s.pairRow}>
              {/* Dispatch promise. New field: it feeds buy-box weight w3 and is
                  what on-time-dispatch is measured against, so it is the one
                  lever besides price a seller can pull to win the buy box. */}
              <Field
                label={t('products.dispatchSla', 'Dispatch within')}
                hint={t('products.dispatchSlaHint', 'Days to hand the order over. Faster offers rank higher.')}
                error={errors.dispatchSla}
                ref={refFor('dispatchSla')}
                style={s.pairCell}
              >
                <TextField
                  editable={!saving}
                  value={form.dispatchSla}
                  onChangeText={setField('dispatchSla')}
                  placeholder="2"
                  keyboardType="number-pad"
                  maxLength={2}
                  error={errors.dispatchSla}
                  suffix={<Text style={s.affixTxt}>{t('products.days', 'days')}</Text>}
                  label={t('products.dispatchSla', 'Dispatch within')}
                />
              </Field>

              <Field
                label={t('products.sellerSku', 'Your stock code')}
                hint={t('products.sellerSkuHint', 'Optional — your own reference. Buyers never see it.')}
                error={errors.sellerSku}
                ref={refFor('sellerSku')}
                style={s.pairCell}
              >
                <TextField
                  editable={!saving}
                  value={form.sellerSku}
                  onChangeText={setField('sellerSku')}
                  placeholder="KSK-1042"
                  autoCapitalize="characters"
                  maxLength={TEXT_MAX.sellerSku}
                  error={errors.sellerSku}
                  label={t('products.sellerSku', 'Your stock code')}
                />
              </Field>
            </View>

            <Field
              label={t('products.harvestDate')}
              hint={t('products.harvestHint')}
              error={errors.harvestDate}
              ref={refFor('harvestDate')}
            >
              <TextField
                editable={!saving}
                value={form.harvestDate}
                onChangeText={setField('harvestDate')}
                placeholder={t('products.harvestPlaceholder')}
                maxLength={TEXT_MAX.harvestDate}
                error={errors.harvestDate}
                label={t('products.harvestDate')}
              />
            </Field>
          </FormSection>

          {/* ── Highlights & specifications ── CATALOG SECTION, create only. */}
          {isCreate ? (
          <FormSection
            icon="list-outline"
            title={t('products.highlightsSpecsTitle')}
            hint={t('products.optionalSection', 'Optional — these help buyers compare, but you can publish without them.')}
            step={sectionSteps.specs}
            total={totalSections}
          >
            <Field
              label={t('rent.brandLabel')}
              hint={t('products.brandHint')}
              error={errors.brand}
              ref={refFor('brand')}
            >
              <TextField
                editable={!saving}
                value={form.brand}
                onChangeText={setField('brand')}
                placeholder={t('products.brandPlaceholder')}
                maxLength={TEXT_MAX.brand}
                error={errors.brand}
                label={t('rent.brandLabel')}
              />
            </Field>

            <Field
              label={t('products.manufacturerLabel')}
              hint={t('products.manufacturerHint')}
              error={errors.manufacturer}
              ref={refFor('manufacturer')}
            >
              <TextField
                editable={!saving}
                value={form.manufacturer}
                onChangeText={setField('manufacturer')}
                placeholder={t('products.manufacturerPlaceholder')}
                maxLength={TEXT_MAX.manufacturer}
                error={errors.manufacturer}
                label={t('products.manufacturerLabel')}
              />
            </Field>

            <Field
              label={t('products.countryOfOrigin')}
              error={errors.countryOfOrigin}
              ref={refFor('countryOfOrigin')}
            >
              <TextField
                editable={!saving}
                value={form.countryOfOrigin}
                onChangeText={setField('countryOfOrigin')}
                placeholder={t('products.countryPlaceholder')}
                maxLength={TEXT_MAX.countryOfOrigin}
                error={errors.countryOfOrigin}
                label={t('products.countryOfOrigin')}
              />
            </Field>

            <Field label={t('product.highlightsTitle')} hint={t('products.highlightsHint')}>
              {highlights.map((h, i) => (
                <View key={`hl-${i}`} style={s.repeatRow}>
                  <TextField
                    editable={!saving}
                    style={{ flex: 1 }}
                    value={h}
                    onChangeText={(v) => updateHighlight(i, v)}
                    placeholder={t('products.highlightPlaceholder', { num: i + 1 })}
                    label={t('products.highlightPlaceholder', { num: i + 1 })}
                  />
                  {highlights.length > 1 ? (
                    <IconButton
                      disabled={saving}
                      icon="remove-circle-outline"
                      size={22}
                      color={C.danger}
                      onPress={() => {
                        dirtyRef.current = true;
                        setHighlights((prev) => prev.filter((_, idx) => idx !== i));
                      }}
                      accessibilityLabel={t('products.removeHighlight', {
                        num: i + 1,
                        defaultValue: `Remove highlight ${i + 1}`,
                      })}
                    />
                  ) : null}
                </View>
              ))}
              <Button
                disabled={saving}
                label={t('products.addHighlight')}
                icon="add-circle-outline"
                variant="ghost"
                size="sm"
                onPress={() => { dirtyRef.current = true; setHighlights((prev) => [...prev, '']); }}
                style={{ alignSelf: 'flex-start' }}
              />
            </Field>

            <Field label={t('product.specifications')} hint={t('products.specsHint')}>
              {specPairs.map((pair, i) => (
                <View key={`spec-${i}`} style={s.repeatRow}>
                  <TextField
                    editable={!saving}
                    style={{ flex: 1 }}
                    value={pair.key}
                    onChangeText={(v) => updateSpec(i, 'key', v)}
                    placeholder={t('products.specLabelPlaceholder')}
                    label={t('products.specLabelPlaceholder')}
                  />
                  <TextField
                    editable={!saving}
                    style={{ flex: 1.3 }}
                    value={pair.value}
                    onChangeText={(v) => updateSpec(i, 'value', v)}
                    placeholder={t('products.specValuePlaceholder')}
                    label={t('products.specValuePlaceholder')}
                  />
                  {specPairs.length > 1 ? (
                    <IconButton
                      disabled={saving}
                      icon="remove-circle-outline"
                      size={22}
                      color={C.danger}
                      onPress={() => {
                        dirtyRef.current = true;
                        setSpecPairs((prev) => prev.filter((_, idx) => idx !== i));
                      }}
                      accessibilityLabel={t('products.removeSpec', {
                        num: i + 1,
                        defaultValue: `Remove specification ${i + 1}`,
                      })}
                    />
                  ) : null}
                </View>
              ))}
              <Button
                disabled={saving}
                label={t('products.addSpecification')}
                icon="add-circle-outline"
                variant="ghost"
                size="sm"
                onPress={() => {
                  dirtyRef.current = true;
                  setSpecPairs((prev) => [...prev, { key: '', value: '' }]);
                }}
                style={{ alignSelf: 'flex-start' }}
              />
            </Field>
          </FormSection>
          ) : null}

          {/* ── Location & reach ── OFFER fields: sellScope + district/taluka are
              what gate buy-box eligibility, so they live on the listing. */}
          <FormSection
            icon="location-outline"
            title={t('products.whereSelling')}
            hint={t('products.sellingReachHint')}
            step={sectionSteps.geo}
            total={totalSections}
          >
            {/* Optional, and first: it fills district, taluka and village. */}
            <Field
              label={t('pincode.label', 'PIN code')}
              error={pinOutsideState
                ? t('sellerBizProfile.pincodeOutsideState', 'This PIN code is outside Maharashtra. Selling is currently limited to Maharashtra.')
                : undefined}
              hint={pin.status === 'idle' ? t('pincode.autofillHint', 'Enter your PIN code to fill in the rest automatically.') : undefined}
            >
              <TextField
                editable={!saving}
                value={pincode}
                onChangeText={(v) => setPincode(sanitizePincode(v))}
                placeholder={t('pincode.placeholder', '6-digit PIN code')}
                keyboardType="number-pad"
                maxLength={PINCODE_INPUT_MAX_LENGTH}
                label={t('pincode.label', 'PIN code')}
              />
              {pin.status !== 'idle' && !pinOutsideState ? (
                <PincodeLocationStatus
                  lookup={pin}
                  PickerComponent={saving ? LockedVillageSheet : VillageSheet}
                />
              ) : null}
            </Field>

            <Field
              label={t('products.district')}
              required
              hint={errors.district ? undefined : t('products.districtHint')}
              error={errors.district}
              ref={refFor('district')}
            >
              <SelectSheet
                disabled={saving}
                title={t('products.selectDistrictTitle')}
                placeholder={t('products.selectDistrict')}
                items={DISTRICT_LIST}
                value={form.district}
                onChange={setField('district')}
                accessibilityLabel={t('products.district')}
              />
            </Field>

            <Field label={t('products.taluka')} hint={t('products.talukaHint')}>
              <SelectSheet
                title={t('products.selectTalukaTitle')}
                placeholder={form.district
                  ? t('products.talukaOptional')
                  : t('products.selectDistrictFirst')}
                items={talukaOptions}
                value={form.taluka}
                onChange={setField('taluka')}
                disabled={saving || !form.district}
                clearLabel={t('products.noneGeneral')}
                accessibilityLabel={t('products.taluka')}
              />
            </Field>

            <Field
              label={t('products.villageTown')}
              hint={t('products.villageTownHint')}
              error={errors.village}
              ref={refFor('village')}
            >
              <TextField
                editable={!saving}
                value={form.village}
                onChangeText={setField('village')}
                placeholder={t('products.villagePlaceholder')}
                maxLength={TEXT_MAX.village}
                error={errors.village}
                label={t('products.villageTown')}
              />
            </Field>

            <Field label={t('products.sellingReach')} required hint={t('products.sellingReachHint')}>
              <View style={{ gap: SP.sm }}>
                {SELLING_SCOPES.map((sc) => (
                  <OptionRow
                    disabled={saving}
                    key={sc.key}
                    selected={form.sellScope === sc.key}
                    onPress={() => setField('sellScope')(sc.key)}
                    icon={sc.icon}
                    title={t('scope.' + sc.tKey)}
                    description={t('scope.' + sc.descKey)}
                  />
                ))}
              </View>
            </Field>
          </FormSection>
        </View>
      </KeyboardAwareScroll>

      <ActionBar>
        {uploadProgress ? (
          <View style={s.uploadBar} accessibilityLiveRegion="polite">
            <Text style={s.uploadTxt}>
              {t('products.uploadingProgress', {
                done: uploadProgress.done,
                total: uploadProgress.total,
                defaultValue: 'Uploading photo {{done}} of {{total}}…',
              })}
            </Text>
            <ProgressBar
              value={uploadProgress.total ? (uploadProgress.done / uploadProgress.total) * 100 : 0}
              height={6}
              label={t('products.uploadingLabel', 'Uploading photos')}
            />
          </View>
        ) : null}
        <Button
          label={isEdit ? t('products.updateProduct') : t('products.listProduct')}
          icon={isEdit ? 'checkmark-circle-outline' : 'add-circle-outline'}
          size="lg"
          fullWidth
          loading={saving}
          disabled={saving}
          onPress={handleSave}
          accessibilityHint={
            isOffline ? t('common.offlineAction', 'You are offline. Reconnect to save this.') : undefined
          }
        />
      </ActionBar>
    </Screen>
  );
}

const s = StyleSheet.create({
  // The form while a save runs: dimmed so it reads as locked, but not so far
  // that the per-photo upload state on the tiles stops being legible.
  formSaving: { opacity: 0.65 },

  // ── Progress card ──
  progressCard: { marginBottom: SP.lg, ...E.raised },

  // ── Attach mode ──
  attachCard: { marginBottom: SP.lg },
  attachRow: { flexDirection: 'row', gap: SP.md, alignItems: 'flex-start' },
  attachImg: { width: 52, height: 52, borderRadius: R.sm, backgroundColor: C.surfaceAlt },
  attachImgEmpty: { alignItems: 'center', justifyContent: 'center' },
  attachName: { ...T.bodyBold, color: C.text },
  attachPack: { ...T.caption, color: C.textMuted, marginTop: 1 },
  attachCompete: { ...T.caption, color: C.brand, marginTop: 3 },
  readOnlyRow: {
    flexDirection: 'row', alignItems: 'center', gap: SP.sm,
    backgroundColor: C.surfaceAlt, borderRadius: R.md,
    paddingHorizontal: SP.md, paddingVertical: SP.sm + 2,
  },
  readOnlyTxt: { ...T.bodyBold, color: C.text },

  progressTop: { flexDirection: 'row', alignItems: 'flex-start', gap: SP.lg },
  progressTitle: { ...T.subhead, color: C.text },
  progressSub: { ...T.caption, color: C.textMuted, marginTop: SP.xs },
  progressFig: { ...T.figureMd, color: C.brandInk },
  progressFigDim: { color: C.textFaint },

  // ── Photos ──
  imgRow: { flexDirection: 'row', gap: SP.md, paddingVertical: SP.xs, paddingRight: SP.xs },
  imgWrap: { position: 'relative' },
  imgThumb: {
    width: 104, height: 104,
    borderRadius: R.lg,
    backgroundColor: C.surfaceSunken,
    borderWidth: 1,
    borderColor: C.border,
  },
  imgOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: R.lg,
    backgroundColor: alpha(C.text, 0.55),
    alignItems: 'center',
    justifyContent: 'center',
  },
  imgCover: {
    position: 'absolute',
    left: SP.sm, bottom: SP.sm,
    paddingHorizontal: SP.sm,
    paddingVertical: 3,
    borderRadius: R.pill,
    backgroundColor: alpha(C.text, 0.72),
  },
  imgCoverTxt: { ...T.micro, fontSize: 10, color: C.onBrand, textTransform: 'uppercase' },
  imgRemove: { position: 'absolute', top: -SP.sm, right: -SP.sm },
  imgRemoveBtn: { width: 30, height: 30, borderRadius: 15, ...E.card },

  imgAdd: {
    width: 104, height: 104,
    borderRadius: R.lg,
    backgroundColor: C.brandPale,
    borderWidth: 1.5, borderColor: alpha(C.brand, 0.4), borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: SP.xs,
  },
  imgAddTxt: { ...T.micro, color: C.brandInk, textTransform: 'uppercase' },
  imgFoot: { flexDirection: 'row', marginTop: SP.md },

  // ── Field layout ──
  pairRow: { flexDirection: 'row', gap: SP.md },
  pairCell: { flex: 1 },
  affixTxt: { ...T.bodyBold, color: C.textMuted },

  repeatRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SP.sm, marginBottom: SP.sm },

  // ── Action bar ──
  uploadBar: { gap: SP.sm, marginBottom: SP.md },
  uploadTxt: { ...T.caption, color: C.textMuted, textAlign: 'center' },
});
