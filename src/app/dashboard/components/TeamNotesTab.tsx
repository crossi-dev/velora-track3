"use client";

import { useEffect, useState, useCallback } from "react";
import { Check, Note } from "@phosphor-icons/react";

interface NoteRow {
  id: string;
  employeeName: string;
  content: string;
  createdAt: string;
}

interface TeamNotesTabProps {
  t: (en: string, es: string) => string;
}

export function TeamNotesTab({ t }: TeamNotesTabProps) {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState<string | null>(null);

  const fetchNotes = useCallback(async () => {
    try {
      const res = await fetch("/api/employee-notes");
      if (!res.ok) return;
      const data = (await res.json()) as { notes: NoteRow[] };
      setNotes(data.notes ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchNotes(); }, [fetchNotes]);

  const [ackError, setAckError] = useState<string | null>(null);

  const ack = useCallback(async (noteId: string) => {
    setAcking(noteId);
    setAckError(null);
    try {
      const res = await fetch("/api/employee-notes/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setAckError(null);
    } catch {
      setAckError(t("Could not mark as read. Try again.", "No se pudo marcar como leído. Intentá de nuevo."));
    } finally {
      setAcking(null);
    }
  }, [t]);

  const sectionStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  };

  const headingStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "1rem",
    fontWeight: 600,
    color: "var(--foreground)",
    margin: 0,
  };

  const cardStyle: React.CSSProperties = {
    background: "var(--surface-raised, var(--card, #fff))",
    border: "1px solid var(--border)",
    borderRadius: "0.75rem",
    padding: "0.875rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  };

  const metaStyle: React.CSSProperties = {
    fontSize: "0.875rem",
    color: "var(--muted-foreground, #6b7280)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const contentStyle: React.CSSProperties = {
    fontSize: "0.9375rem",
    color: "var(--foreground)",
    lineHeight: 1.5,
  };

  const ackButtonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    padding: "0.375rem 0.75rem",
    fontSize: "0.875rem",
    fontWeight: 500,
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    background: "transparent",
    color: "var(--foreground)",
    cursor: "pointer",
    minHeight: 44,
    minWidth: 44,
  };

  const emptyStyle: React.CSSProperties = {
    textAlign: "center",
    padding: "2rem 0",
    color: "var(--muted-foreground, #6b7280)",
    fontSize: "0.9375rem",
  };

  if (loading) {
    return (
      <div style={sectionStyle}>
        <h3 style={headingStyle}>
          <Note size={18} weight="duotone" aria-hidden />
          {t("Team Notes", "Notas del equipo")}
        </h3>
        <p style={{ ...emptyStyle, padding: "1rem 0" }}>
          {t("Loading…", "Cargando…")}
        </p>
      </div>
    );
  }

  return (
    <section style={sectionStyle}>
      <h3 style={headingStyle}>
        <Note size={18} weight="duotone" aria-hidden />
        {t("Team Notes", "Notas del equipo")}
        {notes.length > 0 && (
          <span
            aria-label={t(`${notes.length} pending`, `${notes.length} pendientes`)}
            style={{
              background: "var(--accent, #f59e0b)",
              color: "#fff",
              borderRadius: "1rem",
              fontSize: "0.875rem",
              fontWeight: 700,
              padding: "0.1rem 0.5rem",
              minWidth: "1.5rem",
              textAlign: "center",
            }}
          >
            {notes.length}
          </span>
        )}
      </h3>

      {ackError && (
        <p style={{ fontSize: "0.875rem", color: "var(--danger, #DC2626)", margin: 0 }}>
          {ackError}
        </p>
      )}
      {notes.length === 0 ? (
        <p style={emptyStyle}>
          {t("No pending notes from the team.", "No hay notas pendientes del equipo.")}
        </p>
      ) : (
        notes.map((note) => (
          <div key={note.id} style={cardStyle}>
            <div style={metaStyle}>
              <span style={{ fontWeight: 500 }}>{note.employeeName}</span>
              <span>
                {new Date(note.createdAt).toLocaleTimeString("es-AR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p style={contentStyle}>{note.content}</p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={ackButtonStyle}
                disabled={acking === note.id}
                onClick={() => void ack(note.id)}
                aria-label={t("Mark as read", "Marcar como leído")}
              >
                <Check size={14} weight="bold" aria-hidden />
                {acking === note.id
                  ? t("Saving…", "Guardando…")
                  : t("Mark read", "Marcar leído")}
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
