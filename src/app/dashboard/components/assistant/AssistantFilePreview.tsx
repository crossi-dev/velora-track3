"use client";

import React from "react";
import type { UploadPreview } from "../../lib/hooks/useFileUpload";
import { Button } from "@/components/ui/button";

interface AssistantFilePreviewProps {
  preview: UploadPreview;
  loading: boolean;
  error: string | null;
  /** Dedicated success message — shown instead of the file preview when set. */
  successMsg?: string | null;
  onConfirm: () => void;
  onDismiss: () => void;
  t: (en: string, es: string) => string;
}

export function AssistantFilePreview({
  preview,
  loading,
  error,
  successMsg = null,
  onConfirm,
  onDismiss,
  t,
}: AssistantFilePreviewProps) {
  const label = preview.importType === "products"
    ? t("products", "productos")
    : t("customers", "clientes");

  const displayError = error;

  return (
    <div
      className="rounded-2xl p-4"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
        fontFamily: "var(--font-dm-sans)",
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-body" style={{ fontWeight: 600, color: "var(--tone-strong)", margin: 0 }}>
            {successMsg ?? t(`File detected: ${preview.count} ${label}`, `Archivo detectado: ${preview.count} ${label}`)}
          </p>
          {!successMsg && (
            <p className="text-caption" style={{ color: "var(--tone-muted)", marginTop: "2px" }}>
              {t("First rows:", "Primeras filas:")}
            </p>
          )}
        </div>
        <Button
          type="button"
          onClick={onDismiss}
          aria-label={t("Cancel", "Cancelar")}
          variant="ghost"
          size="icon"
          className="shrink-0 text-[color:var(--tone-muted)] hover:text-[color:var(--tone-muted)]"
          style={{ minHeight: "44px", minWidth: "44px" }}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </Button>
      </div>

      {!successMsg && (
        <>
          <ul className="text-caption mb-4" style={{ listStyle: "none", padding: 0, margin: "0 0 16px 0", color: "var(--tone-strong)" }}>
            {preview.previewItems.map((item, i) => (
              <li key={i} style={{ padding: "3px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                {item}
              </li>
            ))}
            {preview.count > preview.previewItems.length && (
              <li style={{ color: "var(--tone-muted)", padding: "3px 0" }}>
                + {preview.count - preview.previewItems.length} más…
              </li>
            )}
          </ul>

          {displayError && (
            <p className="text-caption mb-3" style={{ color: "var(--danger)" }}>{displayError}</p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={onConfirm}
              disabled={loading}
              className="rounded-full"
              style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)" }}
            >
              {loading ? t("Importing…", "Importando…") : t(`Import ${preview.count} ${label}`, `Importar ${preview.count} ${label}`)}
            </Button>
            <Button
              type="button"
              onClick={onDismiss}
              variant="ghost"
              className="rounded-full"
              style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)" }}
            >
              {t("Cancel", "Cancelar")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
