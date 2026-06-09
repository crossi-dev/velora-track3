import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.somosvelora.app',
  appName: 'Velora',
  webDir: 'out',
  server: {
    // Point WebView to live deployed app (API routes require a server)
    url: 'https://somosvelora.com',
    cleartext: false,
  },
  android: {
    // Allow mixed content for development; disable in production if needed
    allowMixedContent: false,
    // WebView settings
    backgroundColor: '#FFFFFF',
  },
  plugins: {
    StatusBar: {
      // DARK = dark icons/text on light background — matches Velora's cream (#FAF6EE) surface
      style: 'DARK',
      overlaysWebView: true,
      backgroundColor: '#FAF6EE',
    },
    PushNotifications: {
      // presentationOptions controls how foreground push notifications appear on iOS.
      // On Android this is ignored — Android uses notification channels.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    GoogleAuth: {
      // Web/server client ID — used to obtain an idToken the backend can verify.
      // The Android OAuth client (created in Google Console with package name +
      // SHA-1) is NOT referenced here; Google links it by package automatically.
      // See docs/PHONE_AUTH_NATIVE_2026-05-11.md for setup steps.
      clientId: '000000000000-OAUTH_CLIENT_SUFFIX.apps.googleusercontent.com',
      // serverClientId must match clientId so idToken aud equals GOOGLE_WEB_CLIENT_ID.
      serverClientId: '000000000000-OAUTH_CLIENT_SUFFIX.apps.googleusercontent.com',
      scopes: ['email', 'profile', 'openid'],
    },
  },
};

export default config;
