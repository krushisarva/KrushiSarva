/**
 * "Can't reach the server — Retry", shown instead of Login on a cold start when
 * a saved session exists but could not be checked: no signal, a timeout, a 5xx.
 *
 * Login was the wrong answer there. The session is very likely fine, the farmer
 * has no network to receive an OTP with anyway, and nothing ever retried — the
 * app sat on Login until it was killed and reopened with signal.
 *
 * AuthContext owns the logic (restoreFailed, the backoff retries, the retry on
 * return to the foreground); this is only the face of it. A 401 / expired
 * session never lands here — it goes to Login as before.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, Image, StyleSheet } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { KHET, KFONT } from '../constants/khetTheme';

export default function ServerUnreachableScreen() {
  const { retryRestore, restoring, logout } = useAuth();
  const { t } = useLanguage();

  return (
    <View style={s.root}>
      <Image source={require('../assets/state/offline.webp')} style={s.art} resizeMode="contain" />
      <Text style={s.title} accessibilityRole="header">
        {t('login.unreachableTitle', "Can't reach the server")}
      </Text>
      <Text style={s.body}>
        {t('login.unreachableBody', 'Check your internet connection. You are still signed in — we will keep trying.')}
      </Text>
      <TouchableOpacity
        style={[s.btn, restoring && s.btnBusy]}
        onPress={() => { retryRestore(); }}
        disabled={restoring}
        accessibilityRole="button"
        accessibilityState={{ busy: restoring, disabled: restoring }}
      >
        {restoring
          ? <ActivityIndicator color={KHET.primaryForeground} />
          : <Text style={s.btnTxt}>{t('login.unreachableRetry', 'Retry')}</Text>}
      </TouchableOpacity>
      {/* An exit, so a server that keeps failing for this one account can never
          trap the farmer here. Deliberately quiet: it costs them an OTP. */}
      <TouchableOpacity onPress={() => { logout(); }} style={s.link} accessibilityRole="button">
        <Text style={s.linkTxt}>{t('logout', 'Log out')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: KHET.background,
  },
  art: { width: 140, height: 140, marginBottom: 20 },
  title: {
    fontSize: 22,
    fontFamily: KFONT.displaySemi,
    color: KHET.foreground,
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    fontFamily: KFONT.sans,
    color: KHET.mutedForeground,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  btn: {
    minWidth: 160,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: KHET.primary,
    paddingHorizontal: 28,
    borderRadius: 24,
  },
  btnBusy: { opacity: 0.8 },
  btnTxt: { color: KHET.primaryForeground, fontFamily: KFONT.sansBold, fontSize: 15 },
  link: { marginTop: 16, paddingVertical: 12, paddingHorizontal: 16 },
  linkTxt: { color: KHET.mutedForeground, fontFamily: KFONT.sansSemi, fontSize: 14 },
});
