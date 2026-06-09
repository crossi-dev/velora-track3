"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DashboardNotification } from "../types";
import { STORAGE_KEY } from "../storage-keys";

function notificationKey(item: DashboardNotification): string {
  const cta = item.ctaLabel ?? "";
  const body = item.body ?? "";
  const href = item.href ?? "";
  return `${item.id}|${item.kind}|${item.title}|${body}|${cta}|${href}`;
}

export function useNotificationsStore(notifications: DashboardNotification[]) {
  const [seenKeys, setSeenKeys] = useState<Set<string>>(() => new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const seen = localStorage.getItem(STORAGE_KEY.SEEN_NOTIFICATIONS);
      if (seen) setSeenKeys(new Set(JSON.parse(seen) as string[]));
      const dismissed = localStorage.getItem(STORAGE_KEY.DISMISSED_NOTIFICATIONS);
      if (dismissed) setDismissedIds(new Set(JSON.parse(dismissed) as string[]));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const capped = seenKeys.size > 500 ? new Set([...seenKeys].slice(-500)) : seenKeys;
      localStorage.setItem(STORAGE_KEY.SEEN_NOTIFICATIONS, JSON.stringify([...capped]));
    } catch {}
  }, [seenKeys]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY.DISMISSED_NOTIFICATIONS, JSON.stringify([...dismissedIds]));
    } catch {}
  }, [dismissedIds]);

  const markSeen = useCallback((items: DashboardNotification[]) => {
    if (items.length === 0) return;
    setSeenKeys((current) => {
      const next = new Set(current);
      let changed = false;
      for (const item of items) {
        const key = notificationKey(item);
        if (!next.has(key)) { next.add(key); changed = true; }
      }
      return changed ? next : current;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((current) => { const next = new Set(current); next.add(id); return next; });
  }, []);

  const dismissAll = useCallback(() => {
    setDismissedIds((current) => {
      const next = new Set(current);
      for (const n of notifications) next.add(n.id);
      return next;
    });
  }, [notifications]);

  const visibleNotifications = useMemo(
    () => notifications.filter((item) => !dismissedIds.has(item.id)),
    [notifications, dismissedIds]
  );

  const unresolvedCount = useMemo(
    () => visibleNotifications.filter((item) => !seenKeys.has(notificationKey(item))).length,
    [visibleNotifications, seenKeys]
  );

  return { visibleNotifications, unresolvedCount, markSeen, dismiss, dismissAll };
}
