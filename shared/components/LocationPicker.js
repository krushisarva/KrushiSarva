import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  TouchableWithoutFeedback, TextInput, FlatList, useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOWS } from '../constants/colors';
import { useLanguage } from '../context/LanguageContext';

// While searching, the sheet moves to the top and takes at most this share of
// the window, so the results stay above the keyboard. The keyboard's real
// height is not available here: Android reports keyboard changes from the
// activity's root view, not from the dialog window a Modal opens, and the
// dialog is edge-to-edge, so it is not resized for the keyboard either.
const SEARCH_SHEET_SHARE = 0.5;

/**
 * Reusable searchable modal picker.
 * Props:
 *   title      — Modal header title
 *   items      — string[] of options
 *   selected   — currently selected string
 *   onSelect   — (value: string) => void
 *   placeholder— placeholder for the trigger button
 *   disabled   — grey out the button
 *   triggerStyle / triggerTextStyle — optional, to match the form's own inputs
 */
export default function LocationPicker({
  title, items = [], selected, onSelect, placeholder, disabled = false,
  triggerStyle, triggerTextStyle,
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const { height: winHeight } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const placeholderText = placeholder ?? t('locationPicker.selectPlaceholder');

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((it) => it.toLowerCase().includes(q));
  }, [items, query]);

  function close() {
    setOpen(false);
    setQuery('');
    setSearching(false);
  }

  function handleSelect(val) {
    onSelect(val);
    close();
  }

  const sheetPlacement = searching
    ? [s.sheetTop, { top: insets.top + 8, maxHeight: Math.round(winHeight * SEARCH_SHEET_SHARE) }]
    // The navigation bar is drawn over the app (edge-to-edge), so the Cancel
    // button needs the bottom inset or it sits under the system buttons.
    : { bottom: 0, paddingBottom: insets.bottom + 16 };

  return (
    <>
      {/* Trigger Button */}
      <TouchableOpacity
        style={[s.btn, triggerStyle, disabled && s.btnDisabled]}
        onPress={() => !disabled && setOpen(true)}
        activeOpacity={disabled ? 1 : 0.75}
      >
        <Text style={[s.btnTxt, triggerTextStyle, !selected && s.btnPlaceholder]} numberOfLines={1}>
          {selected || placeholderText}
        </Text>
        <Ionicons name="chevron-down" size={18} color={disabled ? COLORS.gray175 : COLORS.gray550} />
      </TouchableOpacity>

      {/* Modal Sheet */}
      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <TouchableWithoutFeedback onPress={close}>
          <View style={s.backdrop} />
        </TouchableWithoutFeedback>

        <View style={[s.sheet, sheetPlacement]}>
          {searching ? null : <View style={s.handle} />}
          <Text style={s.sheetTitle}>{title}</Text>

          {/* Search */}
          <View style={s.searchRow}>
            <Ionicons name="search-outline" size={16} color={COLORS.gray350} />
            <TextInput
              style={s.searchInput}
              placeholder={t('locationPicker.searchPlaceholder')}
              placeholderTextColor={COLORS.gray350}
              value={query}
              onChangeText={setQuery}
              onFocus={() => setSearching(true)}
              onBlur={() => setSearching(false)}
              autoFocus={false}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')}>
                <Ionicons name="close-circle" size={16} color={COLORS.gray350} />
              </TouchableOpacity>
            )}
          </View>

          {filtered.length === 0 ? (
            <View style={s.empty}>
              <Ionicons name="search-outline" size={36} color={COLORS.gray175} />
              <Text style={s.emptyTxt}>{t('locationPicker.noResults', { query })}</Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item}
              style={s.list}
              keyboardShouldPersistTaps="always"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[s.item, item === selected && s.itemActive]}
                  onPress={() => handleSelect(item)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.itemTxt, item === selected && s.itemTxtActive]}>{item}</Text>
                  {item === selected && <Ionicons name="checkmark-circle" size={20} color={COLORS.primary} />}
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => <View style={s.sep} />}
            />
          )}

          {/* Hidden while searching: it would sit under the keyboard, and the
              backdrop and the back button still close the sheet. */}
          {searching ? null : (
            <TouchableOpacity style={s.cancelBtn} onPress={close}>
              <Text style={s.cancelTxt}>{t('cancel')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  btn: {
    backgroundColor: COLORS.white, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.grayBorder,
    paddingHorizontal: 14, paddingVertical: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    ...SHADOWS.small,
  },
  btnDisabled: { backgroundColor: COLORS.grayPaper, borderColor: COLORS.grayBorder },
  btnTxt: { fontSize: 15, color: COLORS.textDark, flex: 1, marginRight: 8 },
  btnPlaceholder: { color: COLORS.gray350 },

  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  // Vertical placement (bottom sheet, or top while searching) is set inline.
  sheet: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '80%',
    ...SHADOWS.large,
  },
  sheetTop: {
    borderBottomLeftRadius: 20, borderBottomRightRadius: 20,
    paddingBottom: 8,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.gray175, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: COLORS.textDark, textAlign: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.grayBg },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginVertical: 10,
    backgroundColor: COLORS.grayPaper, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.grayBorder,
    paddingHorizontal: 12, paddingVertical: 9,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.textDark },

  // flexShrink lets the list give way when the sheet is capped while searching.
  list: { maxHeight: 320, flexGrow: 0, flexShrink: 1 },
  item: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 },
  itemActive: { backgroundColor: COLORS.primary + '08' },
  itemTxt: { fontSize: 15, color: COLORS.textDark },
  itemTxtActive: { color: COLORS.primary, fontWeight: '700' },
  sep: { height: 1, backgroundColor: COLORS.grayBg },
  empty: { padding: 32, alignItems: 'center', gap: 8 },
  emptyTxt: { color: COLORS.gray350, fontSize: 14 },

  cancelBtn: { marginHorizontal: 16, marginTop: 8, backgroundColor: COLORS.grayBg, borderRadius: RADIUS.md, paddingVertical: 14, alignItems: 'center' },
  cancelTxt: { fontSize: 15, fontWeight: '700', color: COLORS.gray550 },
});
