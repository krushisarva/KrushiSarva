/**
 * PIN code helper for the sell-animal form.
 *
 * An animal ad stores its place as ONE line (`sellerLocation`) and no PIN code,
 * so the PIN here is only a way to write that line correctly. The district
 * filter on the animal market matches the district name inside this line, so
 * filling it from India Post also puts the ad under the right district.
 * The rules live in usePincodeLineAutofill.
 */
import { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { COLORS } from '@krushisarva/shared/constants/colors';
import PincodeLocationStatus from '@krushisarva/shared/components/PincodeLocationStatus';
import { usePincodeLineAutofill } from '@krushisarva/shared/hooks/usePincodeLocation';
import { sanitizePincode, PINCODE_INPUT_MAX_LENGTH } from '@krushisarva/shared/utils/pincode';

/**
 * @param {object} p
 * @param {(line: string) => void} p.onLocation
 * @param {boolean} p.lineTypedByUser  the seller edited the location line by hand
 * @param {Function} p.t
 * @param {object} [p.labelStyle]  the form's own label / input styles
 * @param {object} [p.inputStyle]
 */
export default function AnimalPincodeFill({ onLocation, lineTypedByUser, t, labelStyle, inputStyle }) {
  const [pincode, setPincode] = useState('');
  const pin = usePincodeLineAutofill({ pincode, onLine: onLocation, lineTypedByUser });

  return (
    <View style={S.wrap}>
      <Text style={labelStyle}>{t('pincode.label')}</Text>
      <TextInput
        style={inputStyle}
        value={pincode}
        onChangeText={(v) => setPincode(sanitizePincode(v))}
        placeholder={t('pincode.placeholder')}
        placeholderTextColor={COLORS.textLight}
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
