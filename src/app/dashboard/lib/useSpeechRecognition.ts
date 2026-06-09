"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { isCapacitor } from "@/lib/capacitor-helpers";
import {
  shouldAutoSendVoiceTranscript,
} from "./speech-utils";
import { normalizeSpeechInput } from "@/lib/stt/normalize";
import { recoverHomophones } from "@/lib/stt/homophone-recovery";
import { useWebSpeech } from "./useWebSpeech";
import { useNativeSpeech } from "./useNativeSpeech";

interface UseSpeechRecognitionOptions {
  onFinalResult: (text: string, shouldAutoSend: boolean) => void;
  allowShortReply: boolean;
  catalogNames?: string[];
}

/**
 * Public hook for voice input. Composes two independent path hooks:
 * - useWebSpeech: browser SpeechRecognition / webkitSpeechRecognition
 * - useNativeSpeech: Capacitor native plugin (Android)
 *
 * The detect effect picks the path at mount; handleMicClick re-checks at
 * click time in case the Capacitor bridge wasn't ready at mount.
 *
 * State (listening, interim transcript, errors) lives here so both paths
 * share the same source of truth and the UI sees one consistent surface.
 */
export function useSpeechRecognition({ onFinalResult, allowShortReply, catalogNames }: UseSpeechRecognitionOptions) {
  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  // [H2] Permission denied feedback state
  const [permissionDenied, setPermissionDenied] = useState(false);
  // Visible error when speech start fails
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recordingElapsedMsRef = useRef(0);
  const timerDisplayRef = useRef<HTMLElement | null>(null);
  const useNativeRef = useRef(false);
  const permissionGrantedRef = useRef(false);

  // Use refs so callbacks always access current values
  const onFinalResultRef = useRef(onFinalResult);
  onFinalResultRef.current = onFinalResult;
  const allowShortReplyRef = useRef(allowShortReply);
  allowShortReplyRef.current = allowShortReply;
  const catalogNamesRef = useRef<string[]>(catalogNames ?? []);
  catalogNamesRef.current = catalogNames ?? [];

  // ─── Process final text (shared) ───────────────────────────────

  const processFinalText = useCallback((text: string) => {
    const normalized = normalizeSpeechInput(text);
    if (!normalized) return;
    const recovered = catalogNamesRef.current.length > 0
      ? recoverHomophones(normalized, catalogNamesRef.current)
      : normalized;
    const autoSend = shouldAutoSendVoiceTranscript(recovered, {
      allowShortReply: allowShortReplyRef.current,
    });
    onFinalResultRef.current(recovered, autoSend);
  }, []);

  // ─── Compose path-specific sub-hooks ───────────────────────────
  // Each owns its own session refs and self-cleans on unmount.

  const web = useWebSpeech({
    setListening,
    setInterimTranscript,
    setSpeechError,
    processFinalText,
  });

  const native = useNativeSpeech({
    setListening,
    setInterimTranscript,
    setSpeechError,
    setPermissionDenied,
    processFinalText,
    permissionGrantedRef,
  });

  // ─── Detect support ────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function detect() {
      if (isCapacitor()) {
        try {
          const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
          const { available } = await SpeechRecognition.available();
          if (!cancelled && available) {
            useNativeRef.current = true;
            setSpeechSupported(true);
            // Check if permission is already granted (avoid requesting later)
            try {
              const perm = await SpeechRecognition.checkPermissions();
              if (perm.speechRecognition === "granted") {
                permissionGrantedRef.current = true;
              }
            } catch { /* safe */ }
            return;
          }
        } catch {
          // Plugin not available — fall through to web
        }
      }

      const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!cancelled) {
        setSpeechSupported(!!Recognition);
      }
    }

    void detect();

    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Timer display (shared for both paths) ─────────────────────

  useEffect(() => {
    if (!listening) {
      recordingElapsedMsRef.current = 0;
      return;
    }

    const startedAt = Date.now();
    recordingElapsedMsRef.current = 0;
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      recordingElapsedMsRef.current = elapsed;
      if (timerDisplayRef.current) {
        const totalSeconds = Math.max(0, Math.floor(elapsed / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        timerDisplayRef.current.textContent =
          `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [listening]);

  // ─── Stable ref so the max-duration effect never captures a stale closure ──
  // Assigned each render (below, after stopRecognition is defined). Effect calls
  // through the ref so it always reaches the current native.stop / web.stop.
  const stopRecognitionRef = useRef<() => Promise<void>>(async () => undefined);

  // ─── Max recording duration (native) ────────────────────────────

  useEffect(() => {
    if (!listening || !useNativeRef.current) return undefined;

    const maxTimeout = setTimeout(() => {
      void stopRecognitionRef.current();
    }, 10000);

    return () => clearTimeout(maxTimeout);
  }, [listening]);

  // ─── Unified stop ─────────────────────────────────────────────

  async function stopRecognition() {
    if (useNativeRef.current) {
      await native.stop();
    } else {
      web.stop();
    }
  }
  // Keep the ref current so the max-duration effect always calls the latest closure
  stopRecognitionRef.current = stopRecognition;

  // ─── Public handler ────────────────────────────────────────────

  const handleMicClick = () => {
    // Clear feedback messages on any mic tap
    if (permissionDenied) setPermissionDenied(false);
    if (speechError) setSpeechError(null);

    if (listening) {
      void stopRecognition();
      return;
    }

    // Re-check native availability at click time — Capacitor bridge
    // may not have been ready when the mount-time detection ran.
    if (!useNativeRef.current && isCapacitor()) {
      // Bridge is now available but wasn't at mount. Try native path.
      void (async () => {
        try {
          const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
          const { available } = await SpeechRecognition.available();
          if (available) {
            useNativeRef.current = true;
            setSpeechSupported(true);
            void native.start();
            return;
          }
        } catch { /* fall through to web */ }
        // Native not available even with bridge — try web
        web.start();
      })();
      return;
    }

    if (useNativeRef.current) {
      void native.start();
    } else {
      web.start();
    }
  };

  return {
    speechSupported,
    listening,
    interimTranscript,
    permissionDenied,
    speechError,
    timerDisplayRef,
    handleMicClick,
  };
}
