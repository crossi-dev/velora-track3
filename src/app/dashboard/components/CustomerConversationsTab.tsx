"use client";

// CustomerConversationsTab — owner-only inbox of customer WhatsApp threads.
//
// Master-detail pattern:
//   • Master: list of customers that have at least one WhatsApp message,
//     ordered by most recent activity. Each row shows avatar initials,
//     customer name, last message snippet, and relative timestamp.
//   • Detail: full chronological thread for the selected customer (read-only).
//
// Pattern source: master-detail inbox per MUI master-detail docs
// https://mui.com/x/react-data-grid/master-detail/ (HTTP 200 verified 2026-05-29).
// Bubble layout follows WhatsApp Business Platform design conventions
// https://developers.facebook.com/docs/whatsapp/business-platform.
//
// Does NOT touch chatMessageVisibilityFilter — this component intentionally
// reads messages WHERE customerId IS NOT NULL (the customer WhatsApp thread),
// which is the separate customer-side conversation. The owner assistant chat
// (WHERE customerId IS NULL) is unchanged and unaffected.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CustomerConversationsThread } from "./CustomerConversationsThread";
import { SharedEmptyState } from "./SharedEmptyState";
import { ChatsCircle } from "@phosphor-icons/react";

interface ConversationSummary {
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  lastMessage: string;
  lastActivityAt: string | null;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch { return ""; }
}

function initials(name: string): string {
  return name.split(" ").slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

// TanStack Query key for customer conversations list.
// staleTime 30s — conversations list is fresh for 30s; revisiting the tab
// within that window uses the cache instead of re-fetching.
const CONVERSATIONS_QUERY_KEY = ["customer-conversations"] as const;

async function fetchConversations(): Promise<ConversationSummary[]> {
  const r = await fetch("/api/customer-conversations");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()) as { conversations: ConversationSummary[] };
  return d.conversations;
}

export function CustomerConversationsTab() {
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const { data: conversations = [], isLoading: loading, isError: error } = useQuery({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: fetchConversations,
    staleTime: 30_000,
  });

  // Thread view
  if (selected) {
    return (
      <CustomerConversationsThread
        customerId={selected.customerId}
        customerName={selected.customerName}
        customerPhone={selected.customerPhone}
        onBack={() => setSelected(null)}
      />
    );
  }

  // Master list
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* List header */}
      <div style={{ padding: "1rem 1rem 0.5rem", flexShrink: 0 }}>
        <h2 style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1.25rem", fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
          Customer conversations
        </h2>
        <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)", margin: "0.25rem 0 0", lineHeight: 1.4 }}>
          WhatsApp threads — read-only
        </p>
      </div>

      {/* States */}
      {loading && (
        <div style={{ padding: "2rem 1rem", textAlign: "center" }}>
          <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--tone-muted)" }}>Loading…</p>
        </div>
      )}
      {error && (
        <div style={{ padding: "2rem 1rem", textAlign: "center" }}>
          <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--error)" }}>Failed to load conversations.</p>
        </div>
      )}
      {!loading && !error && conversations.length === 0 && (
        <SharedEmptyState
          illustration={<ChatsCircle size={40} weight="duotone" aria-hidden />}
          title="No conversations yet"
          description="Customer WhatsApp messages will appear here once your first customer writes in."
        />
      )}

      {/* Conversation rows */}
      {!loading && !error && conversations.length > 0 && (
        <div className="scrollbar-none" style={{ flex: 1, overflowY: "auto" }}>
          {conversations.map((conv) => (
            <button
              key={conv.customerId}
              type="button"
              onClick={() => setSelected(conv)}
              aria-label={`Open conversation with ${conv.customerName}`}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.875rem 1rem",
                background: "none",
                border: "none",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
                textAlign: "left",
              }}
              className="active:bg-muted/30 hover:bg-muted/20 transition-colors"
            >
              {/* Avatar */}
              <div
                aria-hidden
                style={{
                  width: "2.5rem",
                  height: "2.5rem",
                  borderRadius: "50%",
                  backgroundColor: "var(--brand-soft)",
                  color: "var(--brand)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {initials(conv.customerName)}
              </div>

              {/* Text block */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
                  <span style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", fontWeight: 600, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                    {conv.customerName}
                  </span>
                  <span style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.75rem", color: "var(--tone-muted)", lineHeight: 1.3, flexShrink: 0 }}>
                    {fmtRelative(conv.lastActivityAt)}
                  </span>
                </div>
                <p style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)", margin: "0.125rem 0 0", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {conv.lastMessage || "No messages"}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
