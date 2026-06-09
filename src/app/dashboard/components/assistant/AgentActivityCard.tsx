"use client";

// AgentActivityCard — shows which A2A sub-agents participated in a chat turn.
//
// Renders below the assistant reply bubble as a collapsible "metadata" card.
// Rows appear with a stagger animation (100ms each) to convey agents activating
// in sequence — this makes the coordination visible in the demo video.
//
// Style: gris claro, fuente 0.875rem, no disruptivo — parece metadata, no contenido.

import React, { useEffect, useState } from "react";
import type { AgentActivity } from "../../lib/types";

// ── Sub-component: single activity row ──────────────────────────────────────

function AgentActivityRow({ activity, visible }: { activity: AgentActivity; visible: boolean }) {
  const latencyLabel = activity.latencyMs > 0
    ? `${activity.latencyMs}ms`
    : null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(4px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
        fontSize: "0.875rem",
        lineHeight: 1.4,
        color: "var(--tone-muted)",
        padding: "2px 0",
      }}
    >
      <span style={{ fontSize: "0.875rem", flexShrink: 0 }} aria-hidden="true">
        {activity.icon}
      </span>
      <span style={{ fontWeight: 500, color: "var(--tone-body)", flexShrink: 0 }}>
        {activity.agentLabel}
      </span>
      <span style={{ color: "var(--tone-muted)" }}>
        →
      </span>
      <span style={{ color: "var(--tone-muted)" }}>
        {activity.action}
      </span>
      {latencyLabel && (
        <span
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            fontSize: "0.875rem",
            color: "var(--tone-muted)",
            opacity: 0.7,
          }}
        >
          ({latencyLabel})
        </span>
      )}
    </div>
  );
}

// ── Main card ────────────────────────────────────────────────────────────────

interface AgentActivityCardProps {
  activities: AgentActivity[];
  t: (en: string, es: string) => string;
}

export function AgentActivityCard({ activities, t }: AgentActivityCardProps) {
  // Stagger: each row becomes visible 100ms after the previous one.
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    if (activities.length === 0) return;
    setVisibleCount(0);
    // Track every pending timeout so all are cleared on unmount/re-run.
    const pending: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i <= activities.length; i++) {
      // Initial 80ms delay + 100ms per step to mirror the original stagger.
      const delay = 80 + (i - 1) * 100;
      const id = setTimeout(() => { setVisibleCount(i); }, delay);
      pending.push(id);
    }
    return () => { pending.forEach(clearTimeout); };
  }, [activities.length]);

  if (activities.length === 0) return null;

  return (
    <div
      role="complementary"
      aria-label={t("Agent activity", "Actividad de agentes")}
      style={{
        marginTop: "6px",
        padding: "8px 12px",
        borderRadius: "10px",
        backgroundColor: "var(--surface-subtle, rgba(0,0,0,0.03))",
        border: "1px solid var(--border-subtle, rgba(0,0,0,0.06))",
        maxWidth: "82%",
        alignSelf: "flex-start",
      }}
    >
      {activities.map((activity, index) => (
        <AgentActivityRow
          key={`${activity.agentId}-${index}`}
          activity={activity}
          visible={index < visibleCount}
        />
      ))}
    </div>
  );
}
