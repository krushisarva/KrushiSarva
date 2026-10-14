/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ENV_NAME?: string;
  readonly VITE_API_PROXY?: string;
  // Firebase WEB app config (public, not secrets). All four required ones set →
  // the login screen uses Firebase phone auth; any missing → the MSG91 OTP flow.
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
