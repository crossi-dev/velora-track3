"use client";

import { useEffect, useRef } from "react";
import { tLang } from "./DashboardLangContext";
import { getSpeechError } from "./speech-utils";

interface UseNativeSpeechOptions {
  setListening: (v: boolean) => void;
  setInterimTranscript: (v: string) => void;
  setSpeechError: (v: string | null) => void;
  setPermissionDenied: (v: boolean) => void;
  processFinalText: (text: string) => void;
  /** Set by the parent's detection effect once Capacitor + plugin are confirmed. */
  permissionGrantedRef: React.MutableRefObject<boolean>;
}

/**
 * Capacitor native speech recognition path (@capacitor-community/speech-recognition).
 * Owns its own session state. Cleans up on unmount.
 *
 * Behavior preserved from the original useSpeechRecognition.ts:
 * - Session ID isolation (prevents "second use hang" bug)
 * - Stale-event guards (queued events leak through removeAllListeners)
 * - Permission re-tap flow (Android dialog corrupts SpeechRecognizer mid-flow)
 * - Transient retry for codes 5 (server) and 8 (busy) — once silently
 * - Single finalization path: manual stop, timeout, plugin auto-stop converge
 */
// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function useNativeSpeech({
  setListening,
  setInterimTranscript,
  setSpeechError,
  setPermissionDenied,
  processFinalText,
  permissionGrantedRef,
}: UseNativeSpeechOptions) {
  const lastPartialRef = useRef("");
  const stoppingRef = useRef(false);
  const sessionIdRef = useRef(0);
  const activeSessionIdRef = useRef(0);
  const nativeListenersAttachedAtRef = useRef(0);
  const nativeRetryCountRef = useRef(0);
  // True while the Android permission dialog is open. Blocks re-tap races
  // that otherwise leave SpeechRecognizer in an undefined state.
  const permissionRequestPendingRef = useRef(false);
  // Self-reference so the transient-error retry can call back into this hook's start()
  const startRef = useRef<() => Promise<void>>(async () => {});

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      import("@capacitor-community/speech-recognition").then(({ SpeechRecognition }) => {
        SpeechRecognition.stop().catch(() => {});
        SpeechRecognition.removeAllListeners().catch(() => {});
      }).catch(() => {});
    };
  }, []);

  /**
   * Single finalization path for a native session. Both manual stop,
   * timeout stop, and plugin auto-stop converge here. The session ID
   * check ensures only the current session can finalize.
   */
  async function finishNativeSession(forSession: number) {
    // Only the active session can finalize
    if (activeSessionIdRef.current !== forSession) return;
    if (stoppingRef.current) return;
    stoppingRef.current = true;

    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
      try { await SpeechRecognition.stop(); } catch { /* not running */ }

      // Check session BEFORE removing listeners — if a new session started
      // during the await, its listeners are already registered and we must
      // NOT strip them (race condition fix).
      if (activeSessionIdRef.current !== forSession) {
        stoppingRef.current = false;
        return;
      }

      await SpeechRecognition.removeAllListeners();
    } catch { /* safe */ }

    const text = lastPartialRef.current;
    lastPartialRef.current = "";

    setListening(false);
    setInterimTranscript("");
    stoppingRef.current = false;

    if (text) {
      processFinalText(text);
    }
  }

  // ─── Native Capacitor speech ───────────────────────────────────
  // Each recording session gets a unique ID. Listeners verify the session
  // is still current before acting — stale events from prior sessions
  // are silently ignored. This prevents the "second use hang" bug where
  // a delayed listeningState:"stopped" from session N kills session N+1.

  async function start() {
    // Block re-entry while Android permission dialog is open.
    if (permissionRequestPendingRef.current) {
      console.warn("[native speech] tap ignored — permission dialog in flight");
      return;
    }

    // Increment session ID — any events from prior sessions become stale
    const thisSession = ++sessionIdRef.current;
    activeSessionIdRef.current = thisSession;

    // Reset partial transcript for the new session.
    // Do NOT reset stoppingRef here — a prior finishNativeSession may still
    // be in flight. The session ID guard handles staleness; stoppingRef is
    // only reset safely inside finishNativeSession after completion.
    lastPartialRef.current = "";

    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");

      // Always re-check OS perms each start — a user toggling permission via
      // Settings (deny → grant or grant → deny) must be detected without an
      // app restart. checkPermissions reflects actual OS state; trusting our
      // cached flag would miss user-grant-via-settings after a hard deny.
      try {
        const check = await SpeechRecognition.checkPermissions();
        permissionGrantedRef.current = check.speechRecognition === "granted";
        if (permissionGrantedRef.current) setPermissionDenied(false);
      } catch { /* keep prior cached value */ }

      // Permission gate: if not granted, request and RETURN. The dialog
      // disrupts Android's SpeechRecognizer; user taps again to record.
      if (!permissionGrantedRef.current) {
        // Reset cached "denied" before requesting so the prompt path runs
        // cleanly even if a stale flag would suppress in-app re-prompt UI.
        setPermissionDenied(false);
        permissionRequestPendingRef.current = true;
        try {
          const permResult = await SpeechRecognition.requestPermissions();
          if (permResult.speechRecognition === "denied") {
            setPermissionDenied(true);
            return;
          }
          permissionGrantedRef.current = true;
          // Don't start recording this tap — the permission dialog
          // corrupts the SpeechRecognizer. Let the user tap again.
          setSpeechError(tLang("✓ Microphone ready. Tap again to record.", "✓ Micrófono listo. Tocá de nuevo para grabar."));
          return;
        } catch {
          // Some plugin versions throw if already granted
          permissionGrantedRef.current = true;
        } finally {
          permissionRequestPendingRef.current = false;
        }
      }
      setPermissionDenied(false);
      setSpeechError(null);

      // Cleanup: stop any active recognizer, then remove listeners.
      // stop() is now patched to resolve (see scripts/patch-capacitor-plugins.mjs).
      await SpeechRecognition.removeAllListeners();
      try { await SpeechRecognition.stop(); } catch { /* not running */ }

      // Delay to let Android's SpeechRecognizer fully release audio resources.
      await new Promise<void>((r) => setTimeout(r, 300));

      // Bail if a newer session was started during the delay
      if (activeSessionIdRef.current !== thisSession) return;

      // Safe to reset stoppingRef now — any prior finishNativeSession has either
      // completed or bailed at the session ID check by this point (300ms elapsed).
      stoppingRef.current = false;

      // Register listeners scoped to THIS session
      await SpeechRecognition.addListener("partialResults", (data) => {
        if (activeSessionIdRef.current !== thisSession) return; // stale
        const partial = (data.matches ?? [])[0] ?? "";
        if (partial) {
          lastPartialRef.current = partial;
          setInterimTranscript(partial);
        }
      });

      await SpeechRecognition.addListener("listeningState", (data) => {
        if (activeSessionIdRef.current !== thisSession) return; // stale
        if (data.status === "stopped" && !stoppingRef.current) {
          void finishNativeSession(thisSession);
        }
      });

      // Mark listener-attach time BEFORE registering the speechError
      // listener so the closure-captured guard reads the fresh timestamp
      // even if a stale event fires the moment the listener registers.
      nativeListenersAttachedAtRef.current = Date.now();

      // Listen for native errors (patched plugin emits this on onError)
      // addListener is not in the official @capacitor-community/speech-recognition types — patched plugin adds it
      await (SpeechRecognition as unknown as { addListener: (event: string, cb: (data: Record<string, unknown>) => void) => Promise<{ remove: () => void }> })
        .addListener("speechError", (data) => {
          if (activeSessionIdRef.current !== thisSession) return;

          // Stale-event guard: any event arriving in the first 150ms after
          // listener registration is almost certainly a queued event from
          // the prior session that leaked through removeAllListeners().
          // Real errors from THIS session can only fire after start() has
          // returned, which is a few hundred ms after listener registration.
          const sinceAttached = Date.now() - nativeListenersAttachedAtRef.current;
          if (sinceAttached < 150) {
            console.warn("[native speech] ignoring queued stale error", data.error, `(${sinceAttached}ms)`);
            return;
          }

          // Robust error code parsing — Capacitor's bridge sometimes
          // delivers numeric fields as strings depending on platform.
          const rawError = data.error;
          let errorCode = -1;
          if (typeof rawError === "number") {
            errorCode = rawError;
          } else if (typeof rawError === "string") {
            const parsed = parseInt(rawError, 10);
            if (Number.isFinite(parsed)) errorCode = parsed;
          }

          // Codes 6 (no-speech timeout) and 7 (no-match) are NOT real
          // errors — they just mean the user didn't speak or wasn't
          // understood. Don't show an error toast; just clear the listening
          // state silently. The web path treats no-speech the same way.
          if (errorCode === 6 || errorCode === 7) {
            console.info("[native speech] non-fatal", errorCode, "- silent stop");
            return;
          }

          // Codes 5 (server) and 8 (busy) are typically transient — retry
          // once silently before showing an error. Most auto-recover.
          if ((errorCode === 5 || errorCode === 8) && nativeRetryCountRef.current === 0) {
            nativeRetryCountRef.current = 1;
            console.warn("[native speech] transient error", errorCode, "- retrying once");
            // Reset state and let start bump the session id
            lastPartialRef.current = "";
            stoppingRef.current = false;
            setListening(false);
            setInterimTranscript("");
            setTimeout(() => {
              void startRef.current();
            }, 800);
            return;
          }

          // Real error — show it. Include the raw value + type in the
          // fallback so we can diagnose unmapped codes from user reports.
          const msg = getSpeechError(errorCode);
          console.error("[native speech error]", { rawError, errorCode, msg });
          setSpeechError(msg);
          // Reset retry counter on terminal error
          nativeRetryCountRef.current = 0;
        });

      await SpeechRecognition.start({
        language: "es-AR",
        partialResults: true,
        popup: false,
      });

      // Bail if session was superseded during start()
      if (activeSessionIdRef.current !== thisSession) return;

      // Successful start — reset retry counter
      nativeRetryCountRef.current = 0;

      setListening(true);
      setInterimTranscript("");
    } catch (e) {
      console.error("Native speech recognition error:", e);
      const msg = e instanceof Error ? e.message : tLang("Error starting the microphone.", "Error al iniciar el micrófono.");
      setSpeechError(msg);
      stoppingRef.current = false;
      lastPartialRef.current = "";
      setListening(false);
      setInterimTranscript("");
    }
  }

  // Wire the self-reference for the retry path
  startRef.current = start;

  /** Stop the current native session (manual tap or timeout). */
  async function stop() {
    await finishNativeSession(activeSessionIdRef.current);
  }

  return { start, stop };
}
