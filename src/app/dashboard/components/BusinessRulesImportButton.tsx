"use client";

import { useRef, useState, useId } from "react";
import { FilePdf, CircleNotch } from "@phosphor-icons/react";
import { useChatContext } from "@/app/dashboard/lib/contexts";
import { useT } from "../lib/DashboardLangContext";

interface ImportedRule {
  trigger: string;
  message: string;
}

interface RejectedRule {
  trigger: string;
  error: string;
}

interface ImportResponse {
  imported?: number;
  rules?: ImportedRule[];
  rejected?: RejectedRule[];
  truncated?: boolean;
  chunks?: number;
  message?: string;
  error?: string;
  code?: string;
}

interface Props {
  onImported: () => void;
}

export function BusinessRulesImportButton({ onImported }: Props) {
  const fileInputId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "warn" | "error";
    text: string;
    rules?: ImportedRule[];
    rejected?: RejectedRule[];
  } | null>(null);
  const chat = useChatContext();
  const t = useT();

  async function handleFile(file: File) {
    setLoading(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/business/business-rules/import-document", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as ImportResponse;

      if (!res.ok || data.error) {
        const detail = data.message ?? data.error;
        setNotice({
          kind: "error",
          text: detail ?? t("Could not process the file.", "No se pudo procesar el archivo."),
        });
        return;
      }

      const count = data.imported ?? 0;
      const rules = data.rules ?? [];
      const rejected = data.rejected ?? [];

      // Inject a summary into the owner's chat window
      const chatMsg =
        data.message ??
        (count > 0
          ? t(
              `Analyzed the document: ${count} rule${count === 1 ? "" : "s"} extracted.`,
              `Analicé el documento: ${count} regla${count === 1 ? "" : "s"} extraída${count === 1 ? "" : "s"}.`,
            )
          : t("No rules found in the document.", "No se encontraron reglas en el documento."));
      chat.appendChatHistoryEntry("reply", chatMsg);

      if (count === 0) {
        setNotice({
          kind: "ok",
          text: t("No rules detected.", "Sin reglas detectadas."),
          rejected,
        });
        return;
      }

      if (data.truncated) {
        setNotice({
          kind: "warn",
          text:
            data.message ??
            t(
              "Document too large — only some rules were imported. Split the file.",
              "El documento tiene demasiadas reglas para procesar de una vez — dividilo en partes.",
            ),
          rules,
          rejected,
        });
        onImported();
        return;
      }

      setNotice({
        kind: "ok",
        text: t(
          `${count} rule${count === 1 ? "" : "s"} imported.`,
          `${count} regla${count === 1 ? "" : "s"} importada${count === 1 ? "" : "s"}.`,
        ),
        rules,
        rejected,
      });
      onImported();
    } catch {
      setNotice({
        kind: "error",
        text: t(
          "Connection error while uploading the file.",
          "Error de conexión al subir el archivo.",
        ),
      });
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const noticeColor =
    notice?.kind === "ok"
      ? "var(--accent-green, #16a34a)"
      : notice?.kind === "warn"
        ? "var(--accent-amber, #d97706)"
        : "var(--danger, #dc2626)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <input
        ref={fileRef}
        id={fileInputId}
        type="file"
        accept=".pdf,.docx"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <button
        type="button"
        disabled={loading}
        onClick={() => fileRef.current?.click()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          color: "var(--tone-muted)",
          cursor: loading ? "wait" : "pointer",
          fontFamily: "var(--font-dm-sans)",
          fontSize: "0.875rem",
          whiteSpace: "nowrap",
        }}
      >
        {loading ? (
          <CircleNotch className="icon-sm animate-spin" aria-hidden />
        ) : (
          <FilePdf size={16} weight="duotone" />
        )}
        {loading
          ? t("Processing…", "Procesando…")
          : t("Import from PDF or Word", "Importar desde PDF o Word")}
      </button>

      {loading && (
        <p
          style={{
            margin: 0,
            fontSize: "0.875rem",
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
          }}
        >
          {t("This may take a moment…", "Esto puede tardar un momento…")}
        </p>
      )}

      {notice && (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <p
            style={{
              margin: 0,
              fontSize: "1rem",
              fontFamily: "var(--font-dm-sans)",
              color: noticeColor,
            }}
          >
            {notice.text}
          </p>
          {notice.rules && notice.rules.length > 0 && (
            <ul
              style={{
                margin: 0,
                paddingLeft: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "2px",
              }}
            >
              {notice.rules.map((rule) => (
                <li
                  key={rule.trigger}
                  style={{
                    fontSize: "0.875rem",
                    fontFamily: "var(--font-dm-sans)",
                    color: "var(--tone-muted)",
                  }}
                >
                  <strong style={{ color: "var(--tone-default)" }}>{rule.trigger}</strong>
                  {" — "}
                  {rule.message}
                </li>
              ))}
            </ul>
          )}
          {notice.rejected && notice.rejected.length > 0 && (
            <div style={{ marginTop: "4px" }}>
              <p
                style={{
                  margin: "0 0 2px",
                  fontSize: "1rem",
                  fontFamily: "var(--font-dm-sans)",
                  color: "var(--accent-amber, #d97706)",
                }}
              >
                {t(
                  `${notice.rejected.length} rule${notice.rejected.length === 1 ? "" : "s"} could not be imported:`,
                  `${notice.rejected.length} regla${notice.rejected.length === 1 ? "" : "s"} no se pudo${notice.rejected.length === 1 ? "" : "ieron"} importar:`,
                )}
              </p>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "2px",
                }}
              >
                {notice.rejected.map((r) => (
                  <li
                    key={r.trigger}
                    style={{
                      fontSize: "0.875rem",
                      fontFamily: "var(--font-dm-sans)",
                      color: "var(--tone-muted)",
                    }}
                  >
                    <strong style={{ color: "var(--accent-amber, #d97706)" }}>{r.trigger}</strong>
                    {" — "}
                    {r.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
