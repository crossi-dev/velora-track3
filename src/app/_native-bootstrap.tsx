"use client";

import { useEffect } from "react";
import { installNativeFetchInterceptor, getNativeToken } from "@/lib/native-fetch-interceptor";

// C1: Token is now stored in @capacitor/preferences (Keystore-backed on Android).
// The check is async, so we use a useEffect instead of a top-level side-effect.
// The interceptor is installed as soon as the component mounts if a token exists.
// On desktop the interceptor is a no-op when no token is stored.

/**
 * Mounts at app root and installs the native fetch interceptor if a token
 * exists in platform storage. Runs once per page load.
 */
export function NativeAuthBootstrap() {
  useEffect(() => {
    void getNativeToken().then((token) => {
      if (token) installNativeFetchInterceptor();
    });
  }, []);

  return null;
}
