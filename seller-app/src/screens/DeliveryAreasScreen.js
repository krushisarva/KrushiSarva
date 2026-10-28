/**
 * DeliveryAreasScreen — where this Kendra delivers, how fast, and what extra it
 * charges to go there.
 *
 * Endpoints (existing, unchanged): GET / POST / DELETE
 * /api/v1/agristore/seller-compliance/service-areas
 *
 * WHY THIS SCREEN EXISTS
 * ----------------------
 * The backend has resolved SellerServiceArea rows at quote time for a while —
 * the farmer is shown the seller's own delivery estimate, it is frozen on the
 * order as the promise, and the surcharge is added to that seller's delivery
 * fee (services/shopPricing.service.js). Nothing in either app wrote those rows.
 * So a Kendra that delivers to six villages on its own tempo the same afternoon
 * was quoted to farmers as the platform default, and had no way to charge for
 * the far village.
 *
 * THE FORM COMES FIRST
 * --------------------
 * Adding an area is what a seller comes here to do, and the first one is
 * pre-filled with the shop's own PIN code — so a new seller's first area is one
 * tap. The list sits below it; editing a row loads it into the same form and
 * scrolls back up, rather than opening a second form to keep in step.
 *
 * WHAT IS NOT HERE, ON PURPOSE
 * ----------------------------
 * A row also stores `codAvailable` and `pickupAvailable`. Checkout does not act
 * on either yet — cash on delivery is not refused where a seller turns it off,
 * and there is no collect-from-shop flow — so there are no switches for them:
 * a switch that changes nothing is worse than no switch. Their saved values are
 * carried through an edit untouched (utils/deliveryAreas.js).
 *
 * "Whole district" is not offered either, for the same reason: the backend
 * cannot match a district rule from a PIN code, so its time and charge would
 * never reach a farmer (utils/deliveryAreas.js AREA_KINDS has the detail). The
 * district picker below is kept for the day it can.
 *
 * The list is rendered with map(), not a FlatList: it is one seller's own
 * rules, a handful of rows, inside the scroll view the form needs for the
 * keyboard.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@krushisarva/shared/context/AuthContext";
import { useLanguage } from "@krushisarva/shared/context/LanguageContext";
import api, { safeErrorMessage } from "@krushisarva/shared/services/api";
import { DISTRICT_LIST } from "@krushisarva/shared/constants/locations";

import { C, HIT, SP, T, formatCurrency, useResponsive } from "../theme";
import useAsyncData from "../hooks/useAsyncData";
import { useNetwork } from "../hooks/useNetwork";
import {
  AREA_KINDS,
  areaLabel,
  buildAreaPayload,
  cleanDigits,
  emptyAreaForm,
  etaLabel,
  formFromArea,
  nextFormAfterSave,
  sortAreas,
  upsertArea,
  validateAreaForm,
} from "../utils/deliveryAreas";
import {
  Screen,
  AppHeader,
  Button,
  Card,
  Chip,
  ChipGroup,
  Field,
  TextField,
  FormSection,
  SelectSheet,
  KeyboardAwareScroll,
  InlineNotice,
  ErrorState,
  SkeletonList,
  useConfirm,
  useToast,
} from "../components/ui";

const AREAS_URL = "/agristore/seller-compliance/service-areas";

const KIND_COPY = {
  PIN: { tKey: "deliveryAreas.kindPin", fallback: "One PIN code" },
  PREFIX: { tKey: "deliveryAreas.kindPrefix", fallback: "Nearby PIN codes" },
  DISTRICT: { tKey: "deliveryAreas.kindDistrict", fallback: "Whole district" },
};

// ── Row ──────────────────────────────────────────────────────────────────────

const AreaRow = React.memo(function AreaRow({
  area,
  onEdit,
  onRemove,
  busy,
  disabled,
  editing,
}) {
  const { t } = useLanguage();
  const label = areaLabel(area, t);
  const surcharge = Number(area.surcharge);

  return (
    <Card style={[s.row, editing && s.rowEditing]}>
      <Text style={s.rowTitle} numberOfLines={2}>
        {label}
      </Text>

      <View style={s.rowLine}>
        <Ionicons name="time-outline" size={15} color={C.textMuted} />
        <Text style={s.rowTxt}>
          {t("deliveryAreas.rowEta", {
            eta: etaLabel(area.etaMinDays, area.etaMaxDays, t),
            defaultValue: "Delivery: {{eta}}",
          })}
        </Text>
      </View>
      <View style={s.rowLine}>
        <Ionicons name="cash-outline" size={15} color={C.textMuted} />
        <Text style={s.rowTxt}>
          {surcharge > 0
            ? t("deliveryAreas.rowCharge", {
                amount: formatCurrency(surcharge),
                defaultValue: "Extra charge: {{amount}}",
              })
            : t("deliveryAreas.rowNoCharge", "No extra charge")}
        </Text>
      </View>

      {/* `md`, not `sm`: a `sm` button is 44dp, under the 48dp these two need
          to be hit reliably side by side — and one of them deletes. */}
      <View style={s.rowActions}>
        <Button
          label={t("deliveryAreas.edit", "Change")}
          icon="create-outline"
          variant="secondary"
          size="md"
          disabled={disabled || busy}
          onPress={() => onEdit(area)}
          accessibilityLabel={`${t("deliveryAreas.edit", "Change")}: ${label}`}
          style={s.rowBtn}
        />
        <Button
          label={t("deliveryAreas.remove", "Remove")}
          icon="trash-outline"
          variant="dangerSoft"
          size="md"
          haptic="warning"
          loading={busy}
          disabled={disabled}
          onPress={() => onRemove(area)}
          accessibilityLabel={`${t("deliveryAreas.remove", "Remove")}: ${label}`}
          style={s.rowBtn}
        />
      </View>
    </Card>
  );
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function DeliveryAreasScreen({ navigation }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { isOffline } = useNetwork();
  const { gutter, isExpanded, contentMaxWidth } = useResponsive();

  const scrollRef = useRef(null);
  const [form, setForm] = useState(() => emptyAreaForm(user?.pincode));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const areas = useAsyncData(
    useCallback(
      ({ signal }) =>
        api.get(AREAS_URL, { signal }).then((res) => sortAreas(res.data.data)),
      [],
    ),
    [],
    {
      initialData: [],
      errorFallback: t(
        "deliveryAreas.loadError",
        "Could not load your delivery areas.",
      ),
    },
  );
  const rows = areas.data || [];
  // The state setter is stable; `areas` itself is a new object on every render.
  // Depending on it re-made handleRemove on each keystroke in the form, which
  // re-rendered every memoised AreaRow with it.
  const setAreas = areas.setData;
  const editing = Boolean(form.id);

  // A fresh OTP login leaves only the login response in context — no PIN code —
  // and the full profile can land after this screen has mounted. Fill the first
  // area in then, but only into a form the seller has not started on.
  useEffect(() => {
    const pin = emptyAreaForm(user?.pincode).pincode;
    if (!pin) return;
    setForm((prev) =>
      prev.id || prev.kind !== "PIN" || prev.pincode
        ? prev
        : { ...prev, pincode: pin },
    );
  }, [user?.pincode]);

  // Typing into a field clears that field's error — it was raised on the last
  // submit and no longer describes what is in the box.
  const setField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }, []);

  const startEdit = useCallback((area) => {
    setForm(formFromArea(area));
    setErrors({});
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
  }, []);

  const cancelEdit = useCallback(() => {
    setForm(emptyAreaForm(""));
    setErrors({});
  }, []);

  const handleSave = useCallback(async () => {
    if (saving) return;
    const found = validateAreaForm(form, t);
    setErrors(found);
    if (Object.keys(found).length) {
      toast.error(
        t("deliveryAreas.fixErrors", "Please fix the highlighted fields."),
      );
      return;
    }

    setSaving(true);
    try {
      const res = await api.post(AREAS_URL, buildAreaPayload(form));
      setAreas((prev) => upsertArea(prev, res.data.data));
      toast.success(
        form.id
          ? t("deliveryAreas.updated", "Delivery area updated")
          : t("deliveryAreas.added", "Delivery area added"),
      );
      setForm(nextFormAfterSave(form));
      setErrors({});
    } catch (e) {
      toast.error(
        safeErrorMessage(
          e,
          t(
            "deliveryAreas.saveError",
            "Could not save the delivery area. Please try again.",
          ),
        ),
      );
    } finally {
      setSaving(false);
    }
  }, [form, saving, setAreas, toast, t]);

  const handleRemove = useCallback(
    async (area) => {
      const ok = await confirm({
        title: t("deliveryAreas.removeTitle", "Remove delivery area"),
        message: t("deliveryAreas.removeMsg", {
          area: areaLabel(area, t),
          defaultValue:
            "Farmers in {{area}} will no longer see your delivery time and extra charge.",
        }),
        confirmLabel: t("deliveryAreas.remove", "Remove"),
        cancelLabel: t("cancel", "Cancel"),
        destructive: true,
        icon: "trash-outline",
      });
      if (!ok) return;

      setRemovingId(area.id);
      try {
        await api.delete(`${AREAS_URL}/${area.id}`);
        setAreas((prev) => (prev || []).filter((a) => a.id !== area.id));
        // The row being edited is gone; a save now would re-create it.
        setForm((prev) => (prev.id === area.id ? emptyAreaForm("") : prev));
        toast.success(t("deliveryAreas.removed", "Delivery area removed"));
      } catch (e) {
        toast.error(
          safeErrorMessage(
            e,
            t(
              "deliveryAreas.removeError",
              "Could not remove this delivery area.",
            ),
          ),
        );
      } finally {
        setRemovingId(null);
      }
    },
    [confirm, setAreas, toast, t],
  );

  return (
    <Screen edges={["top", "left", "right"]}>
      <AppHeader
        title={t("deliveryAreas.title", "Delivery areas")}
        subtitle={t(
          "deliveryAreas.subtitle",
          "Where you deliver, how fast, and any extra charge",
        )}
        onBack={() => navigation.goBack()}
      />

      {areas.isInitialLoading ? (
        <SkeletonList count={3} thumb={false} />
      ) : areas.error && !areas.hasLoaded ? (
        <ErrorState error={areas.error} onRetry={areas.retry} />
      ) : (
        <KeyboardAwareScroll
          ref={scrollRef}
          // iOS works out the keyboard overlap from this view's own frame, which
          // starts below the header; the offset adds that height back. The same
          // figure the other form screens pass.
          keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            { padding: gutter, paddingBottom: SP.huge },
            isExpanded && {
              maxWidth: contentMaxWidth,
              width: "100%",
              alignSelf: "center",
            },
          ]}
        >
          <InlineNotice style={s.notice}>
            {rows.length
              ? t(
                  "deliveryAreas.noticeSome",
                  "Farmers in these areas see your delivery time. Your extra charge is added to their delivery fee.",
                )
              : t(
                  "deliveryAreas.noticeNone",
                  "You have not added any area yet, so farmers see the standard delivery time. Add the places you deliver to yourself.",
                )}
          </InlineNotice>

          <FormSection
            icon={editing ? "create-outline" : "add-circle-outline"}
            title={
              editing
                ? t("deliveryAreas.formEditTitle", "Change time and charge")
                : t("deliveryAreas.formAddTitle", "Add a delivery area")
            }
            hint={editing ? areaLabel(formAsArea(form), t) : undefined}
          >
            {/* The area a saved row covers is its identity on the server (one
                row per area), so an edit changes the time and charge only. To
                move a rule to another area, remove it and add the new one. */}
            {editing ? null : (
              <Field label={t("deliveryAreas.kindLabel", "This rule covers")}>
                <ChipGroup
                  accessibilityLabel={t(
                    "deliveryAreas.kindLabel",
                    "This rule covers",
                  )}
                >
                  {AREA_KINDS.map((kind) => (
                    <Chip
                      key={kind}
                      label={t(KIND_COPY[kind].tKey, KIND_COPY[kind].fallback)}
                      selected={form.kind === kind}
                      onPress={() => setField("kind", kind)}
                      accessibilityRole="radio"
                      // The kit's chip is 44dp; these decide what the rule covers.
                      style={s.kindChip}
                    />
                  ))}
                </ChipGroup>
              </Field>
            )}

            {editing ? null : form.kind === "PIN" ? (
              <Field
                label={t("deliveryAreas.pinLabel", "PIN code")}
                required
                error={errors.pincode}
                hint={t(
                  "deliveryAreas.pinHint",
                  "One PIN code usually covers several villages.",
                )}
              >
                <TextField
                  value={form.pincode}
                  onChangeText={(v) => setField("pincode", cleanDigits(v, 6))}
                  placeholder="413102"
                  keyboardType="number-pad"
                  // Longer than 6: Android cuts a paste to maxLength before
                  // onChangeText sees it, so "413 102" would arrive as "413 10".
                  maxLength={10}
                  error={errors.pincode}
                  label={t("deliveryAreas.pinLabel", "PIN code")}
                  testID="delivery-area-pin"
                />
              </Field>
            ) : form.kind === "PREFIX" ? (
              <Field
                label={t(
                  "deliveryAreas.prefixLabel",
                  "First 3 digits of the PIN code",
                )}
                required
                error={errors.pincodePrefix}
                hint={t(
                  "deliveryAreas.prefixHint",
                  "Covers every PIN code that starts with these digits. This is a large area.",
                )}
              >
                <TextField
                  value={form.pincodePrefix}
                  onChangeText={(v) =>
                    setField("pincodePrefix", cleanDigits(v, 3))
                  }
                  placeholder="413"
                  keyboardType="number-pad"
                  maxLength={6}
                  error={errors.pincodePrefix}
                  label={t(
                    "deliveryAreas.prefixLabel",
                    "First 3 digits of the PIN code",
                  )}
                  testID="delivery-area-prefix"
                />
              </Field>
            ) : (
              <Field
                label={t("deliveryAreas.districtLabel", "District")}
                required
                error={errors.district}
              >
                <SelectSheet
                  title={t(
                    "sellerBizProfile.selectDistrictTitle",
                    "Select District",
                  )}
                  placeholder={t(
                    "deliveryAreas.districtPlaceholder",
                    "Choose a district",
                  )}
                  items={DISTRICT_LIST}
                  value={form.district}
                  onChange={(v) => setField("district", v)}
                  accessibilityLabel={t(
                    "deliveryAreas.districtLabel",
                    "District",
                  )}
                />
              </Field>
            )}

            <View style={s.pair}>
              <Field
                label={t("deliveryAreas.etaMinLabel", "Fastest (days)")}
                required
                error={errors.etaMinDays}
                style={s.pairItem}
              >
                <TextField
                  value={form.etaMinDays}
                  onChangeText={(v) =>
                    setField("etaMinDays", cleanDigits(v, 2))
                  }
                  placeholder="1"
                  keyboardType="number-pad"
                  maxLength={2}
                  error={errors.etaMinDays}
                  label={t("deliveryAreas.etaMinLabel", "Fastest (days)")}
                  testID="delivery-area-eta-min"
                />
              </Field>
              <Field
                label={t("deliveryAreas.etaMaxLabel", "Slowest (days)")}
                required
                error={errors.etaMaxDays}
                style={s.pairItem}
              >
                <TextField
                  value={form.etaMaxDays}
                  onChangeText={(v) =>
                    setField("etaMaxDays", cleanDigits(v, 2))
                  }
                  placeholder="2"
                  keyboardType="number-pad"
                  maxLength={2}
                  error={errors.etaMaxDays}
                  label={t("deliveryAreas.etaMaxLabel", "Slowest (days)")}
                  testID="delivery-area-eta-max"
                />
              </Field>
            </View>
            <Text style={s.etaHint}>
              {t(
                "deliveryAreas.etaHint",
                "Use 0 for same-day delivery. The farmer is shown this time, so keep it honest.",
              )}
            </Text>

            <Field
              label={t("deliveryAreas.chargeLabel", "Extra delivery charge")}
              error={errors.surcharge}
              hint={t(
                "deliveryAreas.chargeHint",
                "Added to the farmer’s delivery fee for this area. Leave empty for no extra charge.",
              )}
            >
              <TextField
                value={form.surcharge}
                onChangeText={(v) =>
                  setField("surcharge", v.replace(/[^0-9.]/g, "").slice(0, 9))
                }
                placeholder="0"
                keyboardType="decimal-pad"
                maxLength={9}
                error={errors.surcharge}
                prefix={<Text style={s.rupee}>₹</Text>}
                label={t("deliveryAreas.chargeLabel", "Extra delivery charge")}
                testID="delivery-area-charge"
              />
            </Field>

            <Button
              label={
                editing
                  ? t("deliveryAreas.saveChanges", "Save changes")
                  : t("deliveryAreas.addArea", "Add area")
              }
              icon={editing ? "checkmark" : "add"}
              size="lg"
              fullWidth
              loading={saving}
              disabled={isOffline}
              onPress={handleSave}
              testID="delivery-area-save"
            />
            {editing ? (
              <Button
                label={t("cancel", "Cancel")}
                variant="ghost"
                size="md"
                fullWidth
                disabled={saving}
                onPress={cancelEdit}
                style={{ marginTop: SP.sm }}
              />
            ) : null}
          </FormSection>

          <Text style={s.listTitle} accessibilityRole="header">
            {t("deliveryAreas.listTitle", {
              n: rows.length,
              defaultValue: "Your delivery areas ({{n}})",
            })}
          </Text>

          {rows.length ? (
            rows.map((area) => (
              <AreaRow
                key={area.id}
                area={area}
                onEdit={startEdit}
                onRemove={handleRemove}
                busy={removingId === area.id}
                disabled={isOffline || saving}
                editing={form.id === area.id}
              />
            ))
          ) : (
            <Text style={s.listEmpty}>
              {/* Not "the first one is ready above": the form is pre-filled only
                  when the shop's own PIN code is known. */}
              {t(
                "deliveryAreas.listEmpty",
                "No areas yet. Fill in the form above and tap Add area.",
              )}
            </Text>
          )}
        </KeyboardAwareScroll>
      )}
    </Screen>
  );
}

/** The area fields of a form, in the shape areaLabel() reads. */
function formAsArea(form) {
  return {
    pincode: form.kind === "PIN" ? form.pincode : null,
    pincodePrefix: form.kind === "PREFIX" ? form.pincodePrefix : null,
    district: form.kind === "DISTRICT" ? form.district : null,
    state: form.kind === "STATE" ? form.state : null,
  };
}

const s = StyleSheet.create({
  notice: { marginBottom: SP.lg },
  kindChip: { minHeight: HIT.min },

  pair: { flexDirection: "row", gap: SP.md },
  // minWidth 0 lets the two fields share the row instead of the longer label
  // pushing the other off the card.
  pairItem: { flex: 1, minWidth: 0, marginBottom: SP.sm },
  etaHint: { ...T.caption, color: C.textMuted, marginBottom: SP.xl },
  rupee: { ...T.bodyLg, color: C.textMuted },

  listTitle: {
    ...T.section,
    color: C.textMuted,
    textTransform: "uppercase",
    marginTop: SP.lg,
    marginBottom: SP.md,
  },
  listEmpty: { ...T.body, color: C.textMuted },

  row: { marginBottom: SP.md },
  // Supplementary to the form's own title, which names the area being edited.
  rowEditing: { borderColor: C.brand },
  rowTitle: { ...T.subhead, color: C.text, marginBottom: SP.sm },
  rowLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: SP.sm,
    marginTop: SP.xs,
  },
  rowTxt: { ...T.body, flex: 1, color: C.textBody },
  rowActions: { flexDirection: "row", gap: SP.sm, marginTop: SP.lg },
  rowBtn: { flex: 1 },
});
