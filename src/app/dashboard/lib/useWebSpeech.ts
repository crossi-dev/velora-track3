"use client";

import { useEffect, useRef } from "react";
import { normalizeForMatching } from "@/lib/normalize";
import { tLang } from "./DashboardLangContext";
import type {
  BrowserSpeechRecognition,
  SpeechRecognitionEventLike,
} from "./speech-utils";

interface UseWebSpeechOptions {
  setListening: (v: boolean) => void;
  setInterimTranscript: (v: string) => void;
  setSpeechError: (v: string | null) => void;
  processFinalText: (text: string) => void;
}

/**
 * Web Speech API path. Owns its session state; cleans up on unmount.
 * Guards: growing-final dedup (Android Chrome), 8s silence timer,
 * interim recovery in onend/onerror, stale-session guard.
 */
// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function useWebSpeech({
  setListening,
  setInterimTranscript,
  setSpeechError,
  processFinalText,
}: UseWebSpeechOptions) {
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const webFinalAccumulatorRef = useRef("");
  const webInterimSnapshotRef = useRef("");
  const webSessionIdRef = useRef(0);
  const webSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userCancelledRef = useRef(false);      // tap-stop: discard transcript
  const lowestConfidenceRef = useRef<number | null>(null); // noise gate

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const instance = recognitionRef.current;
      if (instance) {
        instance.onresult = null;
        instance.onerror = null;
        instance.onend = null;
        try { instance.stop(); } catch { /* safe */ }
        recognitionRef.current = null;
      }
      if (webSilenceTimerRef.current) {
        clearTimeout(webSilenceTimerRef.current);
        webSilenceTimerRef.current = null;
      }
    };
  }, []);

  function start() {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setSpeechError(tLang("Voice recognition not available on this device.", "Reconocimiento de voz no disponible en este dispositivo."));
      return;
    }

    // Web Speech API (Chromium) requires network — pre-flight so user sees a clear error.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setSpeechError(tLang("No internet connection. Voice transcription requires network.", "Sin conexión a internet. La transcripción de voz requiere red."));
      return;
    }

    const thisWebSession = ++webSessionIdRef.current;

    const prev = recognitionRef.current;
    if (prev) {
      prev.onresult = null;
      prev.onerror = null;
      prev.onend = null;
      try { prev.stop(); } catch { /* safe */ }
      recognitionRef.current = null;
    }

    if (webSilenceTimerRef.current) { clearTimeout(webSilenceTimerRef.current); webSilenceTimerRef.current = null; }
    webFinalAccumulatorRef.current = "";
    webInterimSnapshotRef.current = "";
    userCancelledRef.current = false;
    lowestConfidenceRef.current = null;

    // 8s silence window: users pause mid-sentence to check shelves/inventory.
    const resetSilenceTimer = () => {
      if (webSilenceTimerRef.current) clearTimeout(webSilenceTimerRef.current);
      webSilenceTimerRef.current = setTimeout(() => {
        if (webSessionIdRef.current !== thisWebSession) return;
        const inst = recognitionRef.current;
        if (inst) {
          try { inst.stop(); } catch { /* safe */ }
        }
      }, 8000);
    };

    try {
      const fresh = new Recognition();
      fresh.lang = "es-AR";
      fresh.continuous = true;
      fresh.interimResults = true;
      fresh.maxAlternatives = 1;

      fresh.onresult = (event: SpeechRecognitionEventLike) => {
        if (webSessionIdRef.current !== thisWebSession) return; // stale

        // Android Chrome re-emits each isFinal as the full growing transcript;
        // pushOrExtend detects the prefix pattern and replaces instead of appending.
        const interimParts: string[] = [];
        const finalParts: string[] = [];

        const normalizeForCompare = (s: string) =>
          normalizeForMatching(s).trim().replace(/\s+/g, " ");

        const pushOrExtend = (parts: string[], text: string) => {
          if (parts.length === 0) {
            parts.push(text);
            return;
          }
          const prev = parts[parts.length - 1];
          const a = normalizeForCompare(text);
          const b = normalizeForCompare(prev);
          if (!b) { parts.push(text); return; }
          if (a === b) return; // identical → no-op
          if (a.startsWith(b)) { parts[parts.length - 1] = text; return; } // extension → replace
          if (b.startsWith(a)) {
            console.debug("[useWebSpeech] discarded shorter dup:", { kept: prev, dropped: text });
            return;
          }
          parts.push(text);
        };

        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const alt = result?.[0];
          const text = (alt?.transcript ?? "").trim();
          if (!text) continue;
          pushOrExtend(result.isFinal ? finalParts : interimParts, text);
          if (result.isFinal && typeof alt?.confidence === "number" && alt.confidence > 0) {
            lowestConfidenceRef.current =
              lowestConfidenceRef.current === null
                ? alt.confidence
                : Math.min(lowestConfidenceRef.current, alt.confidence);
          }
        }
        const fullFinal = finalParts.join(" ");
        const interimText = interimParts.join(" ");

        webFinalAccumulatorRef.current = fullFinal;

        if (interimText) {
          webInterimSnapshotRef.current = interimText;
        } else {
          webInterimSnapshotRef.current = "";
        }

        const display = fullFinal
          ? fullFinal + (interimText ? " " + interimText : "")
          : interimText;
        setInterimTranscript(display || "");

        resetSilenceTimer();
      };

      fresh.onerror = (event: { error?: string }) => {
        if (webSessionIdRef.current !== thisWebSession) return; // stale

        if (event.error === "aborted") return; // fired when we call stop() — truly silent
        // [P1-fix1] no-speech: surface feedback instead of leaving mic frozen.
        if (event.error === "no-speech") {
          webFinalAccumulatorRef.current = "";
          webInterimSnapshotRef.current = "";
          if (webSilenceTimerRef.current) {
            clearTimeout(webSilenceTimerRef.current);
            webSilenceTimerRef.current = null;
          }
          recognitionRef.current = null;
          setListening(false);
          setInterimTranscript("");
          setSpeechError(tLang("Didn't catch that, try again.", "No te escuché, probá de nuevo."));
          return;
        }

        console.error("Speech recognition error:", event.error);

        const finals = webFinalAccumulatorRef.current;
        const interim = webInterimSnapshotRef.current;
        const accumulated = finals
          ? (interim ? `${finals} ${interim}` : finals)
          : interim;
        webFinalAccumulatorRef.current = "";
        webInterimSnapshotRef.current = "";
        if (webSilenceTimerRef.current) {
          clearTimeout(webSilenceTimerRef.current);
          webSilenceTimerRef.current = null;
        }
        recognitionRef.current = null;
        setListening(false);
        setInterimTranscript("");
        if (accumulated) {
          processFinalText(accumulated);
        }
      };

      // [P1-fix2] Noise gate thresholds. MIN_CONFIDENCE only applied when browser
      // exposes it (Chrome/Safari do; Firefox does not). 0.25 rejects ambient noise.
      const MIN_CHARS = 2;
      const MIN_CONFIDENCE = 0.25;

      fresh.onend = () => {
        if (webSessionIdRef.current !== thisWebSession) return; // stale
        const finals = webFinalAccumulatorRef.current;
        const interim = webInterimSnapshotRef.current;
        const accumulated = finals
          ? (interim ? `${finals} ${interim}` : finals)
          : interim;
        const cancelled = userCancelledRef.current;
        const confidence = lowestConfidenceRef.current;
        webFinalAccumulatorRef.current = "";
        webInterimSnapshotRef.current = "";
        userCancelledRef.current = false;
        lowestConfidenceRef.current = null;
        if (webSilenceTimerRef.current) {
          clearTimeout(webSilenceTimerRef.current);
          webSilenceTimerRef.current = null;
        }
        recognitionRef.current = null;
        setListening(false);
        setInterimTranscript("");
        if (cancelled) return; // [P1-fix3] tap-stop discards transcript
        if (!accumulated) return;
        if (accumulated.trim().length < MIN_CHARS) return; // [P1-fix2] noise gate
        if (confidence !== null && confidence < MIN_CONFIDENCE) return;
        processFinalText(accumulated);
      };

      recognitionRef.current = fresh;
      setInterimTranscript("");
      fresh.start();
      setListening(true);

      resetSilenceTimer();
    } catch (e) {
      const msg = e instanceof Error ? e.message : tLang("Could not start the microphone.", "No se pudo iniciar el micrófono.");
      setSpeechError(msg);
      setListening(false);
    }
  }

  function stop() {
    userCancelledRef.current = true; // [P1-fix3] onend will discard transcript
    const current = recognitionRef.current;
    if (current) {
      try { current.stop(); } catch { /* safe */ }
    } else {
      userCancelledRef.current = false;
      setListening(false);
      setInterimTranscript("");
    }
  }

  return { start, stop };
}
