"use client";

// Customer conversation thread view (read-only).
// Renders messages for one customer chronologically — oldest at top, newest at bottom.
// Left bubble = customer inbound (source="customer").
// Right bubble = agent reply  (source="customer_assistant").
//
// Bubble convention: left/right alignment for inbound/outbound is the industry
// standard established by SMS, iMessage, WhatsApp, and documented in the
// WhatsApp Business Platform design guidelines
// https://developers.facebook.com/docs/whatsapp/business-platform.

import { useState, useEffect, useRef } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export interface ThreadMessage {
  id: string;
  source: string;
  text: string;
  createdAt: string;
}

interface ThreadState {
  thread: ThreadMessage[];
  loading: boolean;
  error: boolean;
}

interface CustomerConversationsThreadProps {
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  onBack: () => void;
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function fmtDay(iso: string): string {
  try { return new Date(iso).toLocaleDateString([], { day: "2-digit", month: "short" }); }
  catch { return ""; }
}

function groupByDay(msgs: ThreadMessage[]): Array<{ date: string; messages: ThreadMessage[] }> {
  const acc = new Map<string, ThreadMessage[]>();
  for (const m of msgs) {
    const k = fmtDay(m.createdAt);
    const g = acc.get(k); if (g) g.push(m); else acc.set(k, [m]);
  }
  return Array.from(acc.entries()).map(([date, messages]) => ({ date, messages }));
}

export function CustomerConversationsThread({
  customerId,
  customerName,
  customerPhone,
  onBack,
}: CustomerConversationsThreadProps) {
  const [state, setState] = useState<ThreadState>({ thread: [], loading: true, error: false });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ thread: [], loading: true, error: false });
    fetch(`/api/customer-conversations/${encodeURIComponent(customerId)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ thread: ThreadMessage[] }>; })
      .then((d) => { if (!cancelled) setState({ thread: d.thread, loading: false, error: false }); })
      .catch(() => { if (!cancelled) setState({ thread: [], loading: false, error: true }); });
    return () => { cancelled = true; };
  }, [customerId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [state.thread]);

  const groups = groupByDay(state.thread);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", flexShrink: 0, backgroundColor: "var(--surface)" }}>
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft size={20} weight="bold" aria-hidden />
        </Button>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", fontWeight: 600, margin: 0, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {customerName}
          </p>
          {customerPhone && (
            <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0, lineHeight: 1.3 }}>{customerPhone}</p>
          )}
        </div>
      </div>

      {/* Thread body */}
      <div className="scrollbar-none" style={{ flex: 1, overflowY: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        {state.loading && <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--tone-muted)", textAlign: "center", marginTop: "2rem" }}>Loading…</p>}
        {state.error && <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--error)", textAlign: "center", marginTop: "2rem" }}>Failed to load messages.</p>}
        {!state.loading && !state.error && state.thread.length === 0 && (
          <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--tone-muted)", textAlign: "center", marginTop: "2rem" }}>No messages yet.</p>
        )}
        {groups.map(({ date, messages }) => (
          <div key={date}>
            <div style={{ display: "flex", justifyContent: "center", margin: "0.75rem 0" }}>
              <span style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.75rem", color: "var(--tone-muted)", backgroundColor: "var(--surface)", padding: "0.125rem 0.5rem", borderRadius: "0.75rem", border: "1px solid var(--border)" }}>
                {date}
              </span>
            </div>
            {messages.map((msg) => {
              const isAgent = msg.source === "customer_assistant";
              return (
                <div key={msg.id} style={{ display: "flex", justifyContent: isAgent ? "flex-end" : "flex-start", marginBottom: "0.375rem" }}>
                  <div style={{
                    maxWidth: "75%",
                    backgroundColor: isAgent ? "var(--brand)" : "var(--surface)",
                    color: isAgent ? "#fff" : "var(--foreground)",
                    border: isAgent ? "none" : "1px solid var(--border)",
                    borderRadius: isAgent ? "1rem 1rem 0.25rem 1rem" : "1rem 1rem 1rem 0.25rem",
                    padding: "0.5rem 0.75rem",
                  }}>
                    <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", margin: 0, lineHeight: 1.5, wordBreak: "break-word" }}>{msg.text}</p>
                    <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.75rem", margin: "0.125rem 0 0", lineHeight: 1.2, opacity: 0.65, textAlign: "right" }}>{fmtTime(msg.createdAt)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
