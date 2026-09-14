/**
 * OnboardingNavigator — first-run setup after OTP.
 * Intro (what the app does) → Language → Farm profile (photo, name, location, farm, crops)
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import OnboardingIntroScreen from '../screens/Onboarding/OnboardingIntroScreen';
import OnboardingLanguageScreen from '../screens/Onboarding/OnboardingLanguageScreen';
import OnboardingProfileScreen from '../screens/Onboarding/OnboardingProfileScreen';
import { KHET, KFONT, KRADIUS } from '@krushisarva/shared/constants/khetTheme';

const Stack = createStackNavigator();

// A render error here used to show a farmer the raw message and three lines of
// stack trace, with no button: the only way out was to kill the app. Now it says
// what happened in plain words and offers a retry, which remounts the flow from
// the intro. The technical detail is kept for development builds only.
//
// A class component cannot call useLanguage(), and the language itself may be
// what failed, so the copy is bilingual English + Hindi like the login screen.
class ErrorCatcher extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  retry = () => this.setState({ error: null });
  render() {
    const { error } = this.state;
    if (error) {
      return (
        <View style={ec.root} accessibilityRole="alert">
          <View style={ec.icon}>
            <Ionicons name="refresh" size={28} color={KHET.primary} />
          </View>
          <Text style={ec.title}>Something went wrong</Text>
          <Text style={ec.body}>कुछ गड़बड़ हो गई। कृपया फिर से कोशिश करें।</Text>
          {__DEV__ ? <Text style={ec.dev}>{error.message}</Text> : null}
          <TouchableOpacity style={ec.btn} onPress={this.retry} activeOpacity={0.85} accessibilityRole="button">
            <Text style={ec.btnTxt}>Try again / फिर से कोशिश करें</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const ec = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: KHET.background },
  icon: {
    width: 64, height: 64, borderRadius: 32, marginBottom: 16,
    backgroundColor: KHET.accent, justifyContent: 'center', alignItems: 'center',
  },
  title: { fontSize: 20, fontFamily: KFONT.sansBold, color: KHET.foreground, textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 24, fontFamily: KFONT.sans, color: KHET.mutedForeground, textAlign: 'center', marginTop: 8 },
  dev: { fontSize: 12, color: KHET.destructive, textAlign: 'center', marginTop: 12 },
  btn: {
    marginTop: 24, paddingVertical: 14, paddingHorizontal: 24,
    borderRadius: KRADIUS.r14, backgroundColor: KHET.primary,
  },
  btnTxt: { fontSize: 15, fontFamily: KFONT.sansBold, color: KHET.white },
});

export default function OnboardingNavigator() {
  return (
    <ErrorCatcher>
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false, gestureEnabled: false }}>
          <Stack.Screen name="OnboardingIntro" component={OnboardingIntroScreen} />
          <Stack.Screen name="OnboardingLanguage" component={OnboardingLanguageScreen} />
          <Stack.Screen name="OnboardingProfile" component={OnboardingProfileScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </ErrorCatcher>
  );
}
