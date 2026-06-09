"use client";

import { useRef, useState } from "react";
import type { ChatHistoryEntry } from "../lib/types";
import { InlineNotice } from "./InlineNotice";
import { useT } from "../lib/DashboardLangContext";

interface ImportButtonProps {
  type: "products" | "customers" | "suppliers";
  label: string;
  performImport: (
    type: "products" | "customers" | "suppliers",
    file: File
  ) => Promise<{ imported: number; skipped?: number }>;
  onSuccess: () => void;
  appendChatHistoryEntry?: (kind: ChatHistoryEntry["kind"], text: string) => void;
  tertiary?: boolean;
}

export function ImportButton({
  type,
  label,
  performImport,
  onSuccess,
  appendChatHistoryEntry,
  tertiary,
}: ImportButtonProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setLoading(true);
    setNotice(null);
    setError(null);

    try {
      const data = await performImport(type, file);
      const successMsg = t(
        `${data.imported} records imported${data.skipped ? `, ${data.skipped} skipped` : ""}.`,
        `${data.imported} registros importados${data.skipped ? `, ${data.skipped} omitidos` : ""}.`
      );
      setNotice(successMsg);
      appendChatHistoryEntry?.("success", successMsg);
      onSuccess();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : t("Could not import the file.", "No se pudo importar el archivo.");
      setError(errMsg);
      appendChatHistoryEntry?.("error", errMsg);
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv,.ods"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <button
        type="button"
        disabled={loading}
        onClick={() => inputRef.current?.click()}
        className={tertiary
          ? "text-[0.875rem] font-medium transition-opacity disabled:opacity-45"
          : "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.875rem] font-medium transition-opacity disabled:opacity-45"
        }
        style={tertiary
          ? {
              fontFamily: "var(--font-dm-sans)",
              color: "var(--tone-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 0",
            }
          : {
              fontFamily: "var(--font-dm-sans)",
              borderColor: "var(--border)",
              color: "var(--tone-muted)",
              backgroundColor: "var(--surface)",
            }
        }
      >
        {!tertiary && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        )}
        {loading ? t("Importing…", "Importando…") : label}
      </button>
      {notice ? <InlineNotice message={notice} tone="success" compact /> : null}
      {error ? <InlineNotice message={error} tone="error" compact /> : null}
    </div>
  );
}
