"use client";
import { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "velora_tips_v1";
/** Auto-dismiss the mic tooltip after this many ms so it never blocks chat. */
const MIC_TIP_AUTO_DISMISS_MS = 5000;

interface TipsState {
  mic: boolean;
  input: boolean;
}

function loadTips(): TipsState {
  if (typeof window === "undefined") return { mic: false, input: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mic: false, input: false };
    return JSON.parse(raw) as TipsState;
  } catch {
    return { mic: false, input: false };
  }
}

function saveTips(state: TipsState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — tips won't persist, non-critical
  }
}

export function useFirstLoginTips() {
  const [tips, setTips] = useState<TipsState>({ mic: false, input: false });
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTips(loadTips());
  }, []);

  // Auto-dismiss the mic tooltip after MIC_TIP_AUTO_DISMISS_MS so it never
  // permanently overlaps chat content (Bug 3 fix).
  useEffect(() => {
    if (tips.mic) return; // already dismissed
    autoTimerRef.current = setTimeout(() => {
      const next = { ...tips, mic: true };
      setTips(next);
      saveTips(next);
    }, MIC_TIP_AUTO_DISMISS_MS);
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
    // tips.mic is the only dep that matters here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tips.mic]);

  const showMic = !tips.mic;
  const showInput = tips.mic && !tips.input;

  function dismissMic() {
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    const next = { ...tips, mic: true };
    setTips(next);
    saveTips(next);
  }

  function dismissInput() {
    const next = { ...tips, input: true };
    setTips(next);
    saveTips(next);
  }

  return { showMic, showInput, dismissMic, dismissInput };
}
