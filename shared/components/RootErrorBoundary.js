/**
 * Top-level error boundary — catches uncaught render errors anywhere in the
 * tree and offers a Reload action. Without this, a single bug white-screens
 * the entire app and the user has nothing to do but force-quit.
 *
 * Reload also fetches a newer published update first. The apps never check for
 * updates on launch (checkAutomatically NEVER), and this fallback replaces the
 * whole tree, update banner included; expo-updates' own crash recovery never
 * runs either, because the error was caught here. So when a published update
 * crashes on launch, this button is the only way a user reaches the fix.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Image, ActivityIndicator } from 'react-native';
import { COLORS } from '../constants/colors';
import { captureException } from '../services/crashReporter';

let _Updates = null;
function getUpdates() {
  if (Platform.OS === 'web') return null;
  if (!_Updates) {
    try { _Updates = require('expo-updates'); } catch { _Updates = null; }
  }
  return _Updates;
}

// Same gate as useAppUpdate: dev, Expo Go and development builds (no channel)
// cannot check or fetch.
function canFetchUpdates(Updates) {
  const dev = typeof __DEV__ !== 'undefined' && __DEV__;
  return !dev && !!Updates?.isEnabled && !!Updates?.channel
    && typeof Updates.checkForUpdateAsync === 'function' && typeof Updates.fetchUpdateAsync === 'function';
}

export default class RootErrorBoundary extends React.Component {
  state = { error: null, reloading: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Report the crash to all configured sinks (dev console, backend logs, and
    // any registered external provider). Fatal: a render-tree crash white-screened
    // the app. See services/crashReporter.js.
    captureException(error, { componentStack: info?.componentStack, fatal: true, source: 'errorBoundary' });
  }

  // An instance flag, not state: two taps before a re-render would both read
  // reloading=false.
  reloadInFlight = false;

  reload = async () => {
    if (this.reloadInFlight) return;
    this.reloadInFlight = true;
    this.setState({ reloading: true });
    const Updates = getUpdates();
    if (Updates?.reloadAsync) {
      if (canFetchUpdates(Updates)) {
        try {
          const found = await Updates.checkForUpdateAsync();
          if (found?.isAvailable || found?.isRollBackToEmbedded) await Updates.fetchUpdateAsync();
        } catch { /* offline or no update: reload what is on the phone */ }
      }
      // Stays "reloading" on success: the app is about to restart.
      try { await Updates.reloadAsync(); return; } catch { /* fall through */ }
    }
    this.reloadInFlight = false;
    this.setState({ error: null, reloading: false });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={s.root}>
        {/* A picture first: this screen is shown to a user who may not read the
            copy below it, and it was previously text-only. */}
        <Image source={require('../assets/state/error.webp')}
               style={{ width: 140, height: 140, marginBottom: 20 }} resizeMode="contain" />
        <Text style={s.title}>Something went wrong</Text>
        <Text style={s.body}>
          The app hit an unexpected error. Please reload to try again.
        </Text>
        <TouchableOpacity
          style={s.btn}
          onPress={this.reload}
          disabled={this.state.reloading}
          accessibilityRole="button"
          accessibilityState={{ disabled: this.state.reloading, busy: this.state.reloading }}
        >
          {this.state.reloading
            ? <ActivityIndicator size="small" color={COLORS?.primary ?? '#1B4332'} />
            : <Text style={s.btnTxt}>Reload</Text>}
        </TouchableOpacity>
      </View>
    );
  }
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: COLORS?.primary ?? '#1B4332',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: '#cfe7d8',
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  btn: {
    backgroundColor: '#fff',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    minWidth: 120,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnTxt: {
    color: COLORS?.primary ?? '#1B4332',
    fontWeight: '700',
    fontSize: 15,
  },
});
