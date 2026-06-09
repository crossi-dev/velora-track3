import "server-only";
// Executor — Business Postal Reply Fast Path
//
// Handles the owner's reply when Velora asked for a postal code during a
// payment-link-with-shipping flow. The intent now carries `isCanonical` so the
// executor can route the CP to the correct table:
//
//   isCanonical = true  → "código postal de tu negocio" marker fired
//                          → persist to Business.postalCode (origin, existing path)
//
//   isCanonical = false → destination-CP marker fired ("código postal de destino",
//                          "necesito el código postal", etc.)
//                          → persist to Customer.postalCode for the customer found
//                            in the prior payment-link request in recentHistory.
//
// Flow (canonical path):
//   1. Validate the postal code (isValidPostalCode). If invalid, ask again.
//   2. Save it: prisma.business.update({ postalCode }).
//   3. SEAMLESS RESUME: scan recentHistory for the most recent owner message
//      that looks like a payment-link request. If found, re-run the fast path
//      so the owner gets their link immediately.
//   4. If no prior payment-link request is found, return a confirmation prompt
//      asking the owner to request the link again.
//
// Flow (destination / non-canonical path):
//   1. Validate the postal code.
//   2. Extract customer name from the most recent payment-link request in history.
//   3. Resolve that customer ID from the DB (exact businessId-scoped lookup).
//   4. Save CP to Customer.postalCode.
//   5. Seamless resume: re-run the payment-link fast path with the original text.
//
// Design note on seamless resume: we call executePaymentLinkFastPath directly.
// There is no circular import risk — this file imports from execute-payment-link-
// fast-path.ts, which does NOT import from this file. The dependency is one-way.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { isValidPostalCode } from "@/lib/shipping-quote";
import { detectPaymentLinkFastPath } from "./payment-link-fast-path";
import { executePaymentLinkFastPath } from "./execute-payment-link-fast-path";
import { detectAndreaniIntent } from "./andreani-fast-path";
import { extractCustomerNameFromMessage } from "@/lib/adk/tools/resolve-ventas-shipping";
import type { BusinessPostalReplyIntent } from "./business-postal-reply-fast-path";
import type { PreModelIntentParams } from "../router-params";

export async function executeBusinessPostalReply(
  intent: BusinessPostalReplyIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  // Owner-only belt-and-suspenders (PRIORITY_TABLE guard already checked).
  if (params.actorRole !== "owner") {
    return NextResponse.json({
      answer: "El código postal del negocio lo configura el dueño.",
    });
  }

  const { postalCode, isCanonical } = intent;
  const { businessId } = params;

  // 1. Validate.
  if (!isValidPostalCode(postalCode)) {
    const reAskQuestion = isCanonical
      ? "¿Cuál es el código postal de tu negocio?"
      : "¿Cuál es el código postal de destino del cliente?";
    return NextResponse.json({
      answer:
        "Ese código no parece válido. El código postal debe ser un número de 4 o 5 dígitos " +
        `(por ejemplo: 5500). ${reAskQuestion}`,
    });
  }

  // ── Destination path (non-canonical marker) ───────────────────────────────
  // The Supervisor asked for the customer / destination CP, not the business CP.
  // Persist to Customer.postalCode and resume the payment-link chain.
  if (!isCanonical) {
    return executeDestinationPostalReply(postalCode, intent.matchedMarker, params);
  }

  // ── Canonical path — "código postal de tu negocio" ────────────────────────
  // Persist the origin CP to the business row.
  await prisma.business.update({
    where: { id: businessId },
    data: { postalCode },
  });

  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "BUSINESS_POSTAL_CODE_SAVED",
    a2a_transfer: false,
    message: `Business postal code saved via chat: ${postalCode}`,
    data: { businessId, postalCode },
  });

  // 3a. Best-effort confirm for a prior Andreani / shipment-quote request.
  // We detected a shipment request before the postal code was set. Now that it's
  // saved, we acknowledge the context and ask the owner to restate the request —
  // full auto-resume is intentionally not implemented here (best-effort design).
  const priorAndreaniRequest = findPriorAndreaniRequest(params.recentHistory);
  if (priorAndreaniRequest) {
    return NextResponse.json({
      answer:
        `✅ Listo, guardé el código postal de tu negocio (${postalCode}). ` +
        "Parece que querías cotizar un envío — volvé a pedirlo y lo proceso ahora.",
    });
  }

  // 3b. Seamless resume: find the most recent payment-link request in history.
  const priorLinkRequest = findPriorPaymentLinkRequest(params.recentHistory);

  if (priorLinkRequest) {
    // Re-run the payment-link fast path with the original text.
    // Prefix the answer inside the downstream response is not possible because
    // executePaymentLinkFastPath returns NextResponse directly, so we prepend
    // the confirmation inline by awaiting the call and injecting a prefix.
    const confirmPrefix = `✅ Guardé el código postal de tu negocio (${postalCode}).\n\n`;
    const resumeIntent = { kind: "payment_link_fast_path" as const, rawText: priorLinkRequest };
    const resumeResponse = await executePaymentLinkFastPath(resumeIntent, params);

    // Inject the prefix into the "answer" field of the JSON body.
    const body = await resumeResponse.json() as Record<string, unknown>;
    if (typeof body.answer === "string") {
      body.answer = confirmPrefix + body.answer;
    }
    return NextResponse.json(body, { status: resumeResponse.status });
  }

  // 4. No prior request found — confirm and prompt.
  return NextResponse.json({
    answer:
      `✅ Guardé el código postal de tu negocio (${postalCode}). ` +
      "Ahora pedime el link de pago y lo genero con el envío.",
  });
}

// ── Destination postal code path ──────────────────────────────────────────────

/**
 * Handles the case where the Supervisor asked for the customer/destination CP
 * (non-canonical marker). Writes the CP to Customer.postalCode and resumes.
 *
 * Customer resolution strategy:
 *   1. Find the most recent payment-link request in recentHistory.
 *   2. Extract the customer name from that text (same helper used by
 *      execute-payment-link-fast-path → resolveVentasShipping).
 *   3. DB lookup: prisma.customer.findFirst by businessId + name ILIKE.
 *   4. If resolved: update Customer.postalCode, seamless resume.
 *   5. If NOT resolved: confirm + ask owner to retry (no guess, no corruption).
 */
async function executeDestinationPostalReply(
  postalCode: string,
  matchedMarker: string,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  const { businessId } = params;

  // Find the prior payment-link request to extract the customer name.
  const priorLinkRequest = findPriorPaymentLinkRequest(params.recentHistory);
  const customerName = priorLinkRequest
    ? extractCustomerNameFromMessage(priorLinkRequest)
    : null;

  if (!customerName) {
    // Cannot identify the customer from history — do NOT guess or corrupt any row.
    // Confirm receipt and ask the owner to restate the payment-link request.
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "DESTINATION_POSTAL_NO_CUSTOMER",
      a2a_transfer: false,
      message: `Destination CP received (${postalCode}) but no customer found in recent history — cannot persist`,
      data: { businessId, matchedMarker },
    });
    return NextResponse.json({
      answer:
        `Recibí el código postal ${postalCode}. ` +
        "No pude identificar el cliente en el contexto — volvé a pedirme el link de pago con el nombre del cliente.",
    });
  }

  // Resolve the customer ID by name using diacritic + typo-tolerant matching
  // via f_unaccent + pg_trgm similarity. Replaces previous ILIKE which had no
  // diacritic folding ("Juan" would not match "Juan").
  // Sources: https://www.postgresql.org/docs/current/unaccent.html
  //          https://www.postgresql.org/docs/current/pgtrgm.html
  // Migration: prisma/migrations/20260527230119_unaccent_pgtrgm/migration.sql
  const customerRows = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name
    FROM "Customer"
    WHERE "businessId" = ${businessId}
      AND f_unaccent(name) % f_unaccent(${customerName})
    ORDER BY similarity(f_unaccent(name), f_unaccent(${customerName})) DESC
    LIMIT 1
  `;
  const customer = customerRows[0] ?? null;

  if (!customer) {
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "DESTINATION_POSTAL_CUSTOMER_NOT_FOUND",
      a2a_transfer: false,
      message: `Destination CP received but customer "${customerName}" not found in DB`,
      data: { businessId, customerName, matchedMarker },
    });
    return NextResponse.json({
      answer:
        `Recibí el código postal ${postalCode}, pero no encontré a "${customerName}" en los clientes. ` +
        "Verificá el nombre y volvé a pedirme el link de pago.",
    });
  }

  // Persist the destination CP to Customer.postalCode.
  await prisma.customer.update({
    where: { id: customer.id },
    data: { postalCode },
  });

  cloudLog({
    severity: "INFO",
    component: "Supervisor",
    action: "CUSTOMER_POSTAL_CODE_SAVED",
    a2a_transfer: false,
    message: `Customer postal code saved via chat: ${postalCode}`,
    data: { businessId, customerId: customer.id, customerName: customer.name, postalCode, matchedMarker },
  });

  // Seamless resume: re-run the payment-link fast path with the original text.
  if (priorLinkRequest) {
    const firstName = customer.name.split(" ")[0] ?? customer.name;
    const confirmPrefix = `✅ Guardé el código postal de ${firstName} (${postalCode}).\n\n`;
    const resumeIntent = { kind: "payment_link_fast_path" as const, rawText: priorLinkRequest };
    const resumeResponse = await executePaymentLinkFastPath(resumeIntent, params);

    const body = await resumeResponse.json() as Record<string, unknown>;
    if (typeof body.answer === "string") {
      body.answer = confirmPrefix + body.answer;
    }
    return NextResponse.json(body, { status: resumeResponse.status });
  }

  // No prior link request in history (edge case) — confirm and prompt.
  return NextResponse.json({
    answer:
      `✅ Guardé el código postal de ${customer.name} (${postalCode}). ` +
      "Ahora pedime el link de pago y lo genero con el envío.",
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Scans recentHistory (most recent first) for the last owner/user message that
 * looks like a payment-link creation request.
 * Returns the raw text if found, null otherwise.
 */
function findPriorPaymentLinkRequest(
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>,
): string | null {
  if (!recentHistory || recentHistory.length === 0) return null;
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const entry = recentHistory[i];
    if (entry.role !== "user") continue;
    if (detectPaymentLinkFastPath(entry.text)) return entry.text;
  }
  return null;
}

/**
 * Scans recentHistory (most recent first) for the last owner/user message that
 * looks like an Andreani / shipment-quote request.
 * Returns the raw text if found, null otherwise.
 */
function findPriorAndreaniRequest(
  recentHistory: Array<{ role: "user" | "assistant"; text: string }>,
): string | null {
  if (!recentHistory || recentHistory.length === 0) return null;
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const entry = recentHistory[i];
    if (entry.role !== "user") continue;
    if (detectAndreaniIntent(entry.text) !== null) return entry.text;
  }
  return null;
}
