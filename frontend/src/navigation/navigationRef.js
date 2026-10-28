/**
 * Global navigation ref — lets non-screen code (e.g. the in-app chat banner,
 * push-notification tap handlers) navigate and read the current route without a
 * `navigation` prop. Attached to the NavigationContainer in AppNavigator.
 */
import { createNavigationContainerRef } from '@react-navigation/native';
import { createPendingNavigation } from '../utils/pushRoute';

export const navigationRef = createNavigationContainerRef();

export function navigate(name, params) {
  if (navigationRef.isReady()) navigationRef.navigate(name, params);
}

// `navigate` above drops a call made before the container is ready, which is
// right for a banner tap (the app is plainly up) and wrong for the push tap that
// LAUNCHED the app: that one is read before the tree has mounted. These two hold
// it until AppNavigator's `onReady` — see createPendingNavigation.
const pendingNavigation = createPendingNavigation({
  isReady: () => navigationRef.isReady(),
  navigate: (name, params) => navigationRef.navigate(name, params),
});

export const navigateWhenReady = pendingNavigation.go;
export const flushPendingNavigation = pendingNavigation.flush;

// Innermost active route ({ name, params }) across nested navigators, or null.
export function getActiveRoute() {
  return navigationRef.isReady() ? navigationRef.getCurrentRoute() : null;
}
