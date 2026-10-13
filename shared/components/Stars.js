/**
 * Five stars, to LOOK at — an average on the product page, the rating a farmer
 * already gave, a seller's own rating. The stars a farmer TAPS to give a rating
 * are in the farmer app's ReviewSheet.
 *
 * Shared by both apps so 4.4 is four and a half stars everywhere.
 *
 * Hidden from screen readers on purpose: stars are a picture of a number, and
 * every place that draws them says the number in words beside them. Read out,
 * they would be five unlabelled images.
 */
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import { starKinds } from '../utils/reviewDisplay';

const ICON = { full: 'star', half: 'star-half', empty: 'star-outline' };

export default function Stars({ value, size = 14, color = COLORS.gold, style }) {
  return (
    <View
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 1 }, style]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {starKinds(value).map((kind, i) => (
        // Index is the identity: there are always exactly five, in order.
        <Ionicons key={i} name={ICON[kind]} size={size} color={color} />
      ))}
    </View>
  );
}
