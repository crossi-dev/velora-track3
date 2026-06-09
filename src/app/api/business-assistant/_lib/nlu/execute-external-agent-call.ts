// execute-external-agent-call.ts — executor for external_agent_call intent.
//
// Resolves the peerHint against the TrustedPeerAgent table, calls the peer
// via callExternalAgent, and returns a structured NextResponse with:
//   - 3-option quote chips for wholesale.price.quote
//   - order confirmation text for wholesale.order.create
//   - agentActivity bubbles for the chat UI (🤝 icon)

import { NextResponse } from "next/server";
import { callExternalAgent } from "../handlers/external-agent-call";
import { prisma } from "@/lib/prisma";
import type { ExternalAgentCallIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

// Inline type mirroring QuoteOption from the peer skill (avoids cross-module import).
interface PeerQuoteOption {
  quoteId: string;
  optionLabel: "A" | "B" | "C";
  title: string;
  condition: string;
  productName: string;
  unit: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  deliveryDays: number;
  validUntil: string;
  currency: string;
}

export async function executeExternalAgentCall(
  intent: ExternalAgentCallIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  // Owner-only gate — belt-and-suspenders (detect.ts already guards actorRole)
  if (params.actorRole !== "owner") {
    return NextResponse.json({
      answer: "Las cotizaciones a proveedores las hace el dueño desde su panel.",
    });
  }

  // Resolve domain from TrustedPeerAgent by fuzzy-matching peerHint against agentName
  const peers = await prisma.trustedPeerAgent.findMany({
    where: { businessId: params.businessId },
    select: { domain: true, agentName: true },
  });

  const hint = intent.peerHint.toLowerCase();
  const matched = peers.find((p) =>
    p.agentName.toLowerCase().includes(hint) ||
    hint.includes(p.agentName.toLowerCase().split(" ")[0]!.toLowerCase())
  );

  if (!matched) {
    return NextResponse.json({
      answer: `No encontré "${intent.peerHint}" entre tus proveedores de confianza. Primero agregá el proveedor desde Ajustes → Proveedores de confianza.`,
    });
  }

  const isQuote = intent.skillId === "wholesale.price.quote";
  const skillLabel = isQuote ? "una cotización" : "una orden de compra";
  const callStart = Date.now();

  // Pass productName (not productText) — the peer's skill handlers call
  // findCatalogItem(productName). productText is the NLU-extracted fragment.
  const result = await callExternalAgent({
    businessId: params.businessId,
    domain: matched.domain,
    skillId: intent.skillId,
    params: {
      productName: intent.productText,
      qty: intent.qty,
    },
  });

  const latencyMs = Date.now() - callStart;

  if (!result.ok) {
    return NextResponse.json({
      answer: `Intenté pedir ${skillLabel} a ${matched.agentName} pero hubo un error: ${result.reason}`,
      agentActivity: [
        { agentId: "a2a-peer", agentLabel: matched.agentName, icon: "🤝", action: `error: ${result.reason}`, latencyMs },
      ],
    });
  }

  // A2A activity bubble — visible in chat as a 🤝 card below the reply bubble
  const activityLabel = isQuote ? "cotizó 3 opciones" : "orden creada";
  const agentActivity = [
    { agentId: "a2a-peer", agentLabel: matched.agentName, icon: "🤝", action: activityLabel, latencyMs },
  ];

  // ── Order confirmation ────────────────────────────────────────────────────
  if (!isQuote) {
    const responseText = result.text?.trim() || `Orden enviada a ${matched.agentName}.`;
    return NextResponse.json({
      answer: `**${matched.agentName}** — ${responseText}`,
      agentActivity,
    });
  }

  // ── Quote — 3 options with chip buttons ──────────────────────────────────
  const quoteData = result.data as { quotes?: PeerQuoteOption[] } | null;
  const quotes = quoteData?.quotes;

  if (!quotes || quotes.length === 0) {
    return NextResponse.json({
      answer: `**${matched.agentName}** — ${result.text?.trim() || "Sin cotizaciones disponibles."}`,
      agentActivity,
    });
  }

  const qtyText = intent.qty ? `${intent.qty} ` : "";
  const headerText =
    `**${matched.agentName}** cotizó ${qtyText}${quotes[0]!.productName}:\n\n` +
    quotes
      .map(
        (q) =>
          `**Opción ${q.optionLabel} — ${q.title}**\n` +
          `$${q.totalPrice.toLocaleString("es-AR")} ARS (${q.unitPrice.toLocaleString("es-AR")}/u × ${q.qty})\n` +
          `Entrega: ${q.deliveryDays} día(s) hábil(es)\n` +
          `_${q.condition}_`,
      )
      .join("\n\n");

  // ChipsBundle shape: { kind, options: [{ label, value }] }
  const chips = {
    kind: "single" as const,
    options: quotes.map((q) => ({
      label: `Acepto opción ${q.optionLabel} ($${q.totalPrice.toLocaleString("es-AR")})`,
      value: `comprá la opción ${q.optionLabel} de ${intent.productText} en ${matched.agentName}`,
    })),
  };

  return NextResponse.json({
    answer: headerText,
    chips,
    agentActivity,
    // peerQuoteData is extra metadata for potential future rich card rendering
    peerQuoteData: {
      peerName: matched.agentName,
      productText: intent.productText,
      qty: intent.qty,
      domain: matched.domain,
      quotes,
    },
  });
}
