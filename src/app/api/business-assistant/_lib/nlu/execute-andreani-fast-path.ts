// Executor — Andreani Fast Path
//
// Mock mode: ANDREANI_MOCK_MODE=true (demo env). Returns synthetic but realistic
// responses clearly labeled as simulated (⚠️ SIMULADO prefix).
//
// Real mode: ANDREANI_MOCK_MODE=false. Returns null for ALL skills so the
// Supervisor routes the request to the real Logística agent. Hardcoded prices
// must NEVER be returned when the real Andreani API is available.
//
// Skills handled:
//   shipment.quote  → get shipping cost estimate
//   shipment.create → create shipment and generate label
//   shipment.track  → track a shipment by code

import { NextResponse } from "next/server";
import type { AndreaniIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";
import { cloudLog } from "@/lib/cloud-logger";
import { isAndreaniMockActive } from "@/app/api/agents/andreani/_lib/andreani-mock";
import { prisma } from "@/lib/prisma";
import { getMissingBusinessData } from "../missing-business-data";
import { POSTAL_QUESTION_MARKER } from "./business-postal-reply-fast-path";

// Per-business mock gate: mock only for demo businesses.
// isAndreaniMockActive(businessId) is non-throwing and checks isDemoBusiness internally.

const MOCK_PREFIX = "⚠️ SIMULADO (modo demo, no es cotización real de Andreani)\n\n";

// Destination to zone mapping for quote simulation
function getZoneLabel(destinationHint: string | null, postalCode: string | null): string {
  if (postalCode) return `CP ${postalCode}`;
  if (destinationHint) return destinationHint;
  return "destino indicado";
}

function buildQuoteAnswer(destinationHint: string | null, postalCode: string | null): string {
  const dest = getZoneLabel(destinationHint, postalCode);
  return MOCK_PREFIX + [
    `Andreani te cotiza 3 opciones para enviar a ${dest}:`,
    "",
    "📦 **Standard (3-5 días hábiles)** — $2.850",
    "⚡ **Express (1-2 días hábiles)** — $4.200",
    "🏠 **Andreani en Casa (con turno)** — $3.500",
    "",
    "¿Con cuál querés continuar?",
  ].join("\n");
}

function buildCreateAnswer(
  destinationHint: string | null,
  customerName: string | null,
): string {
  const trackingId = `ARK-${Math.floor(Math.random() * 9000000 + 1000000)}`;
  const dest = destinationHint ?? "destino indicado";
  const recipient = customerName ? ` para ${customerName}` : "";
  return MOCK_PREFIX + [
    `Etiqueta generada para envío${recipient} a ${dest}:`,
    "",
    `📦 Nro. seguimiento: **${trackingId}**`,
    "📄 Etiqueta: andreani.com/imprimir/...",
    "📅 Retiro estimado: mañana entre 9-18hs",
    "",
    "El destinatario recibirá un SMS con el tracking.",
  ].join("\n");
}

function buildTrackAnswer(trackingCode: string | null): string {
  const code = trackingCode ?? "ARK-DEMO";
  // Simulate a realistic tracking chain
  return MOCK_PREFIX + [
    `Seguimiento del envío **${code}**:`,
    "",
    "✅ 14/05 09:15 — Ingresó en sucursal Mendoza Centro",
    "🚚 14/05 14:30 — En tránsito hacia Buenos Aires",
    "📦 15/05 08:00 — En depósito distribución GBA",
    "⏳ 15/05 — En camino a domicilio (estimado 10-14hs)",
    "",
    "Última actualización: hace 2 horas.",
  ].join("\n");
}

export async function executeAndreaniIntent(
  intent: AndreaniIntent,
  params: PreModelIntentParams,
): Promise<NextResponse | null> {
  if (params.actorRole !== "owner") {
    return NextResponse.json({
      answer: "Los envíos con Andreani los coordina el dueño desde su panel.",
    });
  }

  // Composite-intent guard: if the intent has a customer name but no confirmed
  // saleId, it is a "sale + payment + shipment" request that must be orchestrated
  // by the Supervisor LLM (sale → cobro → etiqueta). Returning null here causes
  // the dispatcher to fall through to the Supervisor instead of generating a
  // label without any sale or payment being registered first.
  if (intent.skill === "shipment.create" && intent.customerName !== null && !intent.saleId) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "ANDREANI_FAST_PATH_COMPOSITE_PASSTHROUGH",
      a2a_transfer: false,
      message: "Andreani fast path: composite intent (no saleId) — falling through to Supervisor",
      businessId: params.businessId,
      data: { customerName: intent.customerName },
    });
    return null;
  }

  // Postal-code guard: check before hitting real or mock Andreani.
  // Only applies to quote/create — track doesn't need an origin postal code.
  if (intent.skill === "shipment.quote" || intent.skill === "shipment.create") {
    const businessRow = await prisma.business.findUnique({
      where: { id: params.businessId },
      select: { postalCode: true, paymentProvider: true, alias: true, whatsappPhone: true, cuit: true },
    });
    const missing = getMissingBusinessData({
      postalCode: businessRow?.postalCode,
      paymentProvider: businessRow?.paymentProvider,
      alias: businessRow?.alias,
      whatsappPhone: businessRow?.whatsappPhone,
      cuit: businessRow?.cuit,
    });
    if (missing.shipping.blocked) {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "ANDREANI_POSTAL_CODE_GUARD",
        a2a_transfer: false,
        message: "Andreani guard: postalCode missing, asking owner",
        businessId: params.businessId,
      });
      // Embed the marker phrase so detectBusinessPostalReply fires on the owner's reply.
      return NextResponse.json({
        answer: `Para cotizar el envío necesito el ${POSTAL_QUESTION_MARKER}. ¿Cuál es?`,
      });
    }
  }

  // Real mode: do NOT return hardcoded prices. Pass through to Supervisor so
  // the real Logística agent handles the request via the A2A path.
  if (!isAndreaniMockActive(params.businessId)) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "ANDREANI_FAST_PATH_PASSTHROUGH",
      a2a_transfer: false,
      message: `Andreani fast path: passthrough to Supervisor (real mode)`,
      businessId: params.businessId,
      data: { skill: intent.skill, destinationHint: intent.destinationHint, postalCode: intent.postalCode },
    });
    return null;
  }

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "ANDREANI_FAST_PATH_EXECUTED",
    a2a_transfer: false,
    message: `Andreani fast path: ${intent.skill} (mock mode)`,
    businessId: params.businessId,
    data: { skill: intent.skill, mockMode: true, destinationHint: intent.destinationHint, postalCode: intent.postalCode },
  });

  let answer: string;
  let actionLabel: string;

  switch (intent.skill) {
    case "shipment.quote":
      answer = buildQuoteAnswer(intent.destinationHint, intent.postalCode);
      actionLabel = "envío cotizado (simulado)";
      break;
    case "shipment.create":
      answer = buildCreateAnswer(intent.destinationHint, intent.customerName ?? null);
      actionLabel = "etiqueta generada (simulada)";
      break;
    case "shipment.track":
      answer = buildTrackAnswer(intent.trackingCode);
      actionLabel = "seguimiento consultado (simulado)";
      break;
    default: {
      // Exhaustive guard — should never be reached if AndreaniSkill union is complete.
      const _exhaustive: never = intent.skill;
      answer = `Comando de Andreani no reconocido (${_exhaustive}).`;
      actionLabel = "error";
    }
  }

  return NextResponse.json({
    answer,
    agentActivity: [
      {
        agentId: "andreani",
        agentLabel: "Andreani Agent",
        icon: "📦",
        action: actionLabel,
        latencyMs: 95,
      },
    ],
  });
}
