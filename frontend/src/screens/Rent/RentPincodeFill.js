/**
 * PIN code helper for the rent listing forms (worker and machinery).
 *
 * A rent listing stores its place as two text fields — village/city and
 * district — and no PIN code, so the PIN here is only a way to fill those two
 * correctly. A new listing starts from the farmer's profile PIN (filling only
 * blanks); editing a listing starts empty so nothing saved is touched.
 */
import { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { COLORS } from '@krushisarva/shared/constants/colors';
import PincodeLocationStatus from '@krushisarva/shared/components/PincodeLocationStatus';
import { usePincodeAutofill } from '@krushisarva/shared/hooks/usePincodeLocation';
import { sanitizePincode, PINCODE_INPUT_MAX_LENGTH } from '@krushisarva/shared/utils/pincode';

const FIELDS = { location: 'city', district: 'district' };

/**
 * @param {object} p
 * @param {string} p.location
 * @param {string} p.district
 * @param {(v: string) => void} p.onLocation
 * @param {(v: string) => void} p.onDistrict
 * @param {string} [p.initialPincode]
 * @param {Function} p.t
 * @param {object} [p.labelStyle]  the form's own label / input styles
 * @param {object} [p.inputStyle]
 */
export default function RentPincodeFill({
  location, district, onLocation, onDistrict, initialPincode, t, labelStyle, inputStyle,
}) {
  const [pincode, setPincode] = useState(() => sanitizePincode(initialPincode));
  const pin = usePincodeAutofill({
    pincode,
    values: { location, district },
    fields: FIELDS,
    onChange: (patch) => {
      if ('location' in patch) onLocation(patch.location);
      if ('district' in patch) onDistrict(patch.district);
    },
  });

  return (
    <View style={S.wrap}>
      <Text style={labelStyle}>{t('pincode.label')}</Text>
      <TextInput
        style={inputStyle}
        value={pincode}
        onChangeText={(v) => setPincode(sanitizePincode(v))}
        placeholder={t('pincode.placeholder')}
        placeholderTextColor={COLORS.grayLightMid}
        keyboardType="number-pad"
        maxLength={PINCODE_INPUT_MAX_LENGTH}
        accessibilityLabel={t('pincode.label')}
      />
      {pin.status === 'idle'
        ? <Text style={S.hint}>{t('pincode.autofillHint')}</Text>
        : <PincodeLocationStatus lookup={pin} />}
    </View>
  );
}

const S = StyleSheet.create({
  wrap: { marginBottom: 14 },
  hint: { fontSize: 12, color: COLORS.textMedium, marginTop: 6 },
});
