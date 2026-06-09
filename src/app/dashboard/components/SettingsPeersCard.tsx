"use client";

// Card "Peers de confianza" en Ajustes → Negocio.
// Permite al owner agregar, ver y quitar agentes A2A externos de confianza.
// El Supervisor puede invocar skills de estos agentes desde el chat.

import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/DashboardLangContext";
import { CARD_CLASS, CARD_STYLE, CARD_TITLE_STYLE } from "./SettingsShared";

interface PeerSkill {
  id: string;
  name: string;
  description: string;
}

interface TrustedPeer {
  id: string;
  domain: string;
  agentName: string;
  skills: PeerSkill[];
  addedAt: string;
  lastUsedAt: string | null;
}

interface PeersResponse {
  peers: TrustedPeer[];
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--border)",
  fontSize: "0.875rem",
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  backgroundColor: "var(--surface)",
  outline: "none",
  boxSizing: "border-box",
};

const PRIMARY_BTN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.5rem 1rem",
  borderRadius: "0.375rem",
  border: "none",
  fontSize: "0.875rem",
  fontWeight: 600,
  fontFamily: "var(--font-dm-sans)",
  backgroundColor: "var(--brand)",
  color: "var(--accent-cream)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const DANGER_BTN: React.CSSProperties = {
  ...PRIMARY_BTN,
  backgroundColor: "transparent",
  color: "var(--danger)",
  border: "1px solid var(--danger)",
  padding: "0.25rem 0.75rem",
};

export function SettingsPeersCard() {
  const t = useT();
  const [peers, setPeers] = useState<TrustedPeer[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPeers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/peers/trusted", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as PeersResponse;
      setPeers(data.peers ?? []);
    } catch {
      setError(t("Could not load peers.", "No se pudieron cargar los peers."));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPeers();
  }, [loadPeers]);

  const handleAdd = useCallback(async () => {
    const trimmed = domain.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/peers/trusted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: trimmed }),
      });
      const data = (await res.json()) as { ok?: boolean; agentName?: string; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? t("Could not add peer.", "No se pudo agregar el peer."));
      } else {
        setNotice(t(
          `"${data.agentName ?? trimmed}" added.`,
          `"${data.agentName ?? trimmed}" agregado.`,
        ));
        setDomain("");
        await loadPeers();
      }
    } catch {
      setError(t("Network error.", "Error de red."));
    } finally {
      setAdding(false);
    }
  }, [domain, loadPeers, t]);

  const handleRemove = useCallback(async (peerDomain: string, peerName: string) => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/peers/trusted", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: peerDomain }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setNotice(t(`"${peerName}" removed.`, `"${peerName}" quitado.`));
      await loadPeers();
    } catch {
      setError(t("Could not remove peer.", "No se pudo quitar el peer."));
    }
  }, [loadPeers, t]);

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>{t("Trusted Peers (A2A)", "Peers de confianza (A2A)")}</p>
      <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: "0 0 1rem" }}>
        {t(
          "Add external A2A agents your Supervisor can invoke from chat.",
          "Agregá agentes A2A externos que el Supervisor puede invocar desde el chat.",
        )}
      </p>

      {/* Add peer input row */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
          placeholder={t(
            "somosvelora.com/api/peers/distribuidora-mendoza",
            "somosvelora.com/api/peers/distribuidora-mendoza",
          )}
          style={INPUT_STYLE}
          disabled={adding}
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding || !domain.trim()}
          style={{ ...PRIMARY_BTN, opacity: adding || !domain.trim() ? 0.6 : 1 }}
        >
          {adding ? t("Adding…", "Agregando…") : t("Add", "Agregar")}
        </button>
      </div>

      {/* Notices */}
      {notice && (
        <p style={{ fontSize: "0.875rem", color: "var(--success)", marginBottom: "0.75rem" }}>
          {notice}
        </p>
      )}
      {error && (
        <p style={{ fontSize: "0.875rem", color: "var(--danger)", marginBottom: "0.75rem" }}>
          {error}
        </p>
      )}

      {/* Peers list */}
      {loading ? (
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)" }}>
          {t("Loading…", "Cargando…")}
        </p>
      ) : peers.length === 0 ? (
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", fontStyle: "italic" }}>
          {t("No trusted peers yet.", "Sin peers de confianza aún.")}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {peers.map((peer) => (
            <PeerRow key={peer.id} peer={peer} onRemove={handleRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

function PeerRow({
  peer,
  onRemove,
}: {
  peer: TrustedPeer;
  onRemove: (domain: string, name: string) => void;
}) {
  const t = useT();
  return (
    <div
      style={{
        padding: "0.75rem",
        borderRadius: "0.375rem",
        border: "1px solid var(--border)",
        backgroundColor: "var(--surface-subtle, #fafafa)",
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
        <span style={{ fontWeight: 700, fontSize: "0.875rem", color: "var(--tone-strong)" }}>
          {peer.agentName}
        </span>
        <button
          type="button"
          onClick={() => onRemove(peer.domain, peer.agentName)}
          style={DANGER_BTN}
        >
          {t("Remove", "Quitar")}
        </button>
      </div>
      <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", wordBreak: "break-all" }}>
        {peer.domain}
      </span>
      {peer.skills.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.25rem" }}>
          {peer.skills.map((s) => (
            <span
              key={s.id}
              title={s.description}
              style={{
                display: "inline-block",
                padding: "0.125rem 0.5rem",
                borderRadius: "999px",
                fontSize: "0.875rem",
                backgroundColor: "var(--surface-muted, #f3f4f6)",
                color: "var(--tone-muted)",
                border: "1px solid var(--border)",
              }}
            >
              {s.id}
            </span>
          ))}
        </div>
      )}
      {peer.lastUsedAt && (
        <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)" }}>
          {t("Last used:", "Último uso:")} {new Date(peer.lastUsedAt).toLocaleString("es-AR")}
        </span>
      )}
    </div>
  );
}
