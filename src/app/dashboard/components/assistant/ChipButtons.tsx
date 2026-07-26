"use client";

import { useState, useCallback } from "react";
import type { ChipsBundle, ChipOption } from "../../lib/types";
import { subscribeOwnerPush } from "../../lib/hooks/subscribeOwnerPush";
import { useT } from "../../lib/DashboardLangContext";

// Chip button — ≥44×44 px target per Velora typography/touch standard.
const CHIP_BTN_BASE: React.CSSProperties = {
  minHeight: "44px",
  minWidth: "44px",
  padding: "10px 14px",
  borderRadius: "999px",
  fontSize: "0.875rem",
  fontWeight: 600,
  lineHeight: 1.2,
  cursor: "pointer",
  transition: "opacity 150ms ease, background-color 150ms ease",
};

export function ChipButtons({
  bundle,
  onSendChip,
  role,
  loadingParse = false,
}: {
  bundle: ChipsBundle;
  onSendChip: (text: string) => void;
  role: string;
  loadingParse?: boolean;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const handleSingle = useCallback((opt: ChipOption) => {
    if (busy) return;
    setBusy(true);
    try {
      onSendChip(opt.value);
    } finally {
      setBusy(false);
    }
  }, [busy, onSendChip]);

  const toggleMulti = useCallback((value: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }, []);

  const handleAction = useCallback(async (opt: ChipOption) => {
    if (busy) return;
    setBusy(true);
    try {
      if (opt.action === "subscribe_push") {
        await subscribeOwnerPush();
      }
      onSendChip(opt.value);
    } finally {
      setBusy(false);
    }
  }, [busy, onSendChip, role]);

  const submitMulti = useCallback(() => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    try {
      const ordered = bundle.options
        .filter((o) => picked.has(o.value))
        .map((o) => o.value);
      onSendChip(ordered.join(", "));
    } finally {
      setBusy(false);
    }
  }, [busy, picked, bundle.options, onSendChip]);

  const isMulti = bundle.kind === "multi";

  return (
    <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "6px", maxWidth: "100%" }}>
      {bundle.options.map((opt) => {
        const isPicked = isMulti && picked.has(opt.value);
        const handler = bundle.kind === "single"
          ? () => handleSingle(opt)
          : bundle.kind === "action"
            ? () => handleAction(opt)
            : () => toggleMulti(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={handler}
            disabled={(busy || loadingParse) && !isMulti}
            style={{
              ...CHIP_BTN_BASE,
              backgroundColor: isPicked ? "var(--action-primary-bg)" : "var(--surface-subtle)",
              color: isPicked ? "var(--action-primary-fg)" : "var(--tone-strong)",
              border: isPicked ? "none" : "1px solid var(--bubble-border)",
              opacity: (busy || loadingParse) && !isMulti ? 0.6 : 1,
            }}
          >
            {opt.label}
          </button>
        );
      })}
      {isMulti && (
        <button
          type="button"
          onClick={submitMulti}
          disabled={busy || loadingParse || picked.size === 0}
          style={{
            ...CHIP_BTN_BASE,
            backgroundColor: "var(--action-primary-bg)",
            color: "var(--action-primary-fg)",
            border: "none",
            opacity: busy || loadingParse || picked.size === 0 ? 0.45 : 1,
          }}
        >
          {t("Done", "Listo")}
        </button>
      )}
    </div>
  );
}
