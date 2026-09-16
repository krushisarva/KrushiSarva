/**
 * The line under a PIN code field: what the pincode resolved to, or why it
 * didn't, plus a village picker when the pincode covers more than one.
 *
 * Pair it with usePincodeAutofill():
 *
 *   const pin = usePincodeAutofill({ pincode, values, fields, onChange });
 *   <TextInput value={pincode} ... />
 *   <PincodeLocationStatus lookup={pin} />
 *
 * Renders nothing while the field is empty or still being typed. A lookup
 * that could not run (offline, India Post down) says so and offers Retry; the
 * form stays fully usable by hand.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import { useLanguage } from '../context/LanguageContext';
import LocationPicker from './LocationPicker';

const WARNING = {
  unavailable: ['pincode.unavailable', "Couldn't check this PIN code right now. You can fill in the details yourself."],
  offline: ['pincode.offline', "You're offline. Fill in the details yourself, or retry when connected."],
  rate_limited: ['pincode.rateLimited', 'Too many PIN code checks. Please wait a minute and retry.'],
};

/**
 * @param {object} props
 * @param {ReturnType<import('../hooks/usePincodeLocation').usePincodeAutofill>} props.lookup
 * @param {boolean} [props.showPicker=true]  offer the village picker
 * @param {object} [props.style]
 * @param {object} [props.pickerTriggerStyle]
 * @param {object} [props.pickerTriggerTextStyle]
 * @param {React.ComponentType} [props.PickerComponent]  a picker with
 *        LocationPicker's props, for screens that have their own
 */
export default function PincodeLocationStatus({
  lookup, showPicker = true, style, pickerTriggerStyle, pickerTriggerTextStyle,
  PickerComponent = LocationPicker,
}) {
  const { t } = useLanguage();
  const status = lookup?.status;
  const summary = lookup?.summary;
  const localities = lookup?.localities || [];

  const labels = useMemo(() => localities.map((l) => l.label), [localities]);
  const selected = localities.find((l) => l.key === lookup?.selectedKey);

  if (!lookup || status === 'idle' || status === 'incomplete') return null;

  if (status === 'loading') {
    return (
      <View style={[s.row, style]} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={COLORS.primary} />
        <Text style={[s.text, s.muted]}>{t('pincode.checking', 'Finding your area…')}</Text>
      </View>
    );
  }

  if (status === 'invalid' || status === 'not_found') {
    const message = status === 'invalid'
      ? t('pincode.invalid', 'Enter a valid 6-digit PIN code.')
      : t('pincode.notFound', 'No area found for this PIN code. Please check the number.');
    return (
      <View style={[s.row, style]} accessibilityLiveRegion="polite">
        <Ionicons name="alert-circle" size={16} color={COLORS.crimson} />
        <Text style={[s.text, s.error]}>{message}</Text>
      </View>
    );
  }

  if (WARNING[status]) {
    const [key, fallback] = WARNING[status];
    return (
      <View style={[s.row, style]} accessibilityLiveRegion="polite">
        <Ionicons name="cloud-offline-outline" size={16} color={COLORS.amberDark2} />
        <Text style={[s.text, s.warning]}>{t(key, fallback)}</Text>
        <TouchableOpacity
          onPress={lookup.retry}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
        >
          <Text style={s.retry}>{t('pincode.retry', 'Retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (status !== 'found' || !summary) return null;

  const needsChoice = localities.length > 1;
  return (
    <View style={style}>
      <View style={s.row} accessibilityLiveRegion="polite">
        <Ionicons name="location" size={16} color={COLORS.primary} />
        <Text style={[s.text, s.found]} numberOfLines={2}>
          {selected ? joinPlace(selected) : summary.label}
        </Text>
      </View>
      {needsChoice && showPicker ? (
        <View style={s.picker}>
          {!selected ? (
            <Text style={[s.text, s.muted, s.hint]}>
              {summary.ambiguous
                ? t('pincode.multipleDistricts', 'This PIN code covers more than one district. Select your village or area.')
                : t('pincode.pickArea', 'Select your village or area to fill in the rest.')}
            </Text>
          ) : null}
          <PickerComponent
            title={t('pincode.pickAreaTitle', { pincode: summary.pincode, defaultValue: 'Villages and areas in {{pincode}}' })}
            items={labels}
            selected={selected?.label}
            placeholder={t('pincode.pickAreaCount', { count: localities.length, defaultValue: 'Select village / area ({{count}})' })}
            onSelect={(label) => lookup.selectLocality(localities.find((l) => l.label === label))}
            triggerStyle={pickerTriggerStyle}
            triggerTextStyle={pickerTriggerTextStyle}
          />
        </View>
      ) : null}
    </View>
  );
}

function joinPlace(l) {
  const seen = new Set();
  return [l.name, l.taluka, l.district, l.state]
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(', ');
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  text: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  muted: { color: COLORS.textMedium },
  found: { color: COLORS.primary, fontWeight: '600' },
  error: { color: COLORS.crimson },
  warning: { color: COLORS.amberDark2 },
  retry: { color: COLORS.primary, fontWeight: '700', fontSize: 13 },
  picker: { marginTop: 8 },
  hint: { marginBottom: 6 },
});
