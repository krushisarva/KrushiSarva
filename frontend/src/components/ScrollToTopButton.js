/**
 * ScrollToTopButton — Floating button that scrolls the list to top.
 * Appears when header is collapsed; disappears when at top.
 */
import React from 'react';
import { TouchableOpacity, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '@krushisarva/shared/constants/colors';
import { useLanguage } from '@krushisarva/shared/context/LanguageContext';

export default function ScrollToTopButton({ visible, onPress }) {
  const { t } = useLanguage();
  if (!visible) return null;
  return (
    <TouchableOpacity style={styles.btn} onPress={onPress} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('a11y.scrollToTop', 'Scroll to top')}>
      <Ionicons name="arrow-up" size={18} color="#FFF" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    position: 'absolute',
    bottom: 90,
    alignSelf: 'center',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
});
