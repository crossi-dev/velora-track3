"use client";
// SettingsMemoryCard — displays learned Velora preferences for this owner.
// Owner can delete individual memories or all at once.
// Only visible when USE_MEMORY_BANK=true (server signals via `enabled` flag).

import { useState, useEffect, useCallback } from "react";
import {
  CARD_CLASS,
  CARD_STYLE,
  CARD_TITLE_STYLE,
} from "./SettingsShared";

interface Memory {
  name: string;
  content: string;
  createTime: string;
}

interface ApiResponse {
  memories: Memory[];
  enabled: boolean;
}

function formatDate(iso: string, lang: "en" | "es-AR"): string {
  try {
    return new Date(iso).toLocaleDateString(lang === "en" ? "en-US" : "es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

interface Props {
  t: (en: string, es: string) => string;
  lang?: "en" | "es-AR";
}

export function SettingsMemoryCard({ t, lang = "es-AR" }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memories");
      if (!res.ok) return;
      const data = await res.json() as ApiResponse;
      setEnabled(data.enabled);
      setMemories(data.memories ?? []);
    } catch {
      // fail-soft: don't surface error in UI
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchMemories(); }, [fetchMemories]);

  async function deleteSingle(memoryName: string) {
    setDeleting(memoryName);
    setDeleteError(null);
    try {
      const res = await fetch("/api/memories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryName }),
      });
      if (!res.ok) {
        setDeleteError(t("Could not forget this memory. Try again.", "No se pudo olvidar esta memoria. Intentá de nuevo."));
        return;
      }
      setMemories((prev) => prev.filter((m) => m.name !== memoryName));
    } catch {
      setDeleteError(t("Network error. Could not forget this memory.", "Error de red. No se pudo olvidar esta memoria."));
    } finally {
      setDeleting(null);
    }
  }

  async function deleteAll() {
    setDeletingAll(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/memories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteAll: true }),
      });
      if (!res.ok) {
        setDeleteError(t("Could not forget all memories. Try again.", "No se pudieron olvidar las memorias. Intentá de nuevo."));
        return;
      }
      setMemories([]);
    } catch {
      setDeleteError(t("Network error. Could not forget all memories.", "Error de red. No se pudieron olvidar las memorias."));
    } finally {
      setDeletingAll(false);
    }
  }

  // Hidden entirely when the feature flag is off
  if (!loading && !enabled) return null;

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
        <p style={{ ...CARD_TITLE_STYLE, margin: 0 }}>
          {t("Velora Memories", "Memorias de Velora")}
        </p>
        {memories.length > 0 && (
          <button
            type="button"
            disabled={deletingAll}
            onClick={() => { void deleteAll(); }}
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--danger)",
              background: "none",
              border: "1px solid var(--danger)",
              borderRadius: "var(--radius-md)",
              padding: "4px 10px",
              cursor: deletingAll ? "not-allowed" : "pointer",
              opacity: deletingAll ? 0.6 : 1,
              minHeight: "32px",
            }}
          >
            {deletingAll
              ? t("Forgetting...", "Olvidando...")
              : t("Forget all", "Olvidar todo")}
          </button>
        )}
      </div>

      {loading && (
        <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
          {t("Loading...", "Cargando...")}
        </p>
      )}

      {deleteError && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          padding: "8px 10px",
          backgroundColor: "var(--danger-soft)",
          borderRadius: "var(--radius-sm)",
          marginBottom: "8px",
        }}>
          <span style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--danger)" }}>
            {deleteError}
          </span>
          <button
            type="button"
            onClick={() => { setDeleteError(null); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", padding: "0 4px", fontSize: "0.875rem", fontWeight: 600 }}
            aria-label={t("Dismiss", "Cerrar")}
          >
            ✕
          </button>
        </div>
      )}

      {!loading && memories.length === 0 && (
        <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
          {t(
            "No memories yet. Velora will learn your preferences as you chat.",
            "Todavía no hay memorias. Velora aprende tus preferencias mientras chateás.",
          )}
        </p>
      )}

      {!loading && memories.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
          {memories.map((m) => (
            <li
              key={m.name}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "12px",
                padding: "8px 10px",
                backgroundColor: "var(--surface-subtle)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                <span style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  color: "var(--tone-body)",
                  lineHeight: 1.4,
                  wordBreak: "break-word",
                }}>
                  {m.content}
                </span>
                <span style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  color: "var(--tone-muted)",
                }}>
                  {formatDate(m.createTime, lang)}
                </span>
              </div>
              <button
                type="button"
                disabled={deleting === m.name}
                onClick={() => { void deleteSingle(m.name); }}
                aria-label={t("Forget this memory", "Olvidar esta memoria")}
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  color: "var(--tone-muted)",
                  background: "none",
                  border: "none",
                  cursor: deleting === m.name ? "not-allowed" : "pointer",
                  opacity: deleting === m.name ? 0.4 : 1,
                  padding: "2px 6px",
                  flexShrink: 0,
                  minHeight: "28px",
                }}
              >
                {t("Forget", "Olvidar")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
