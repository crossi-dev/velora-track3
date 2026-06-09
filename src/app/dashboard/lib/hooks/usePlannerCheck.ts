"use client";

import { useEffect, useRef } from "react";

// Velora Manager (Agent 2) — login trigger.
// Fires once per dashboard mount, fire-and-forget. Calls POST /api/planner/notify
// which dedupes server-side via clientMessageId. Failure is silent (chat will
// still receive cron writes; this is a "first chance" surface only).

export function usePlannerCheck() {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    fetch("/api/planner/notify", { method: "POST" }).catch((err) => {
      console.error("[planner/notify] mount fire-and-forget failed", err);
    });
  }, []);
}
