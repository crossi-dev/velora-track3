// POST /api/integrations/fiscal/connect-delegation — owner-only.
//
// Onboards a merchant via PROVIDER DELEGATION: the merchant adds Velora's provider
// CUIT as an authorized representative in AFIP Administrador de Relaciones for the
// WSFE service. No cert upload is required — Velora signs WSAA with its own
// single provider certificate and passes the merchant's CUIT as <ar:Cuit> in WSFE.
//
// Delegation model (verified against wsaa.ts + wsfe-builders.ts):
//   • WSAA: signed with Velora's cert → ticket is tied to Velora's provider CUIT.
//   • WSFE Auth.Cuit: carries the MERCHANT's CUIT (the represented party).
//   • This is supported out-of-the-box by wsfe-builders.authXml(cuit, ticket) which
//     takes the merchant cuit and provider-derived ticket as separate arguments.
//
// Request body (JSON):
//   { puntoVenta: number, condicionIva: "RI"|"MT"|"EX"|"CF" }
//
// Flow:
//   1. Auth: resolveActor + requireRole(owner).
//   2. Rate limit (upload bucket).
//   3. Parse + validate JSON body.
//   4. Load merchant CUIT from Business row (required).
//   5. Upsert ArcaCredential with isProviderDelegation=true; no cert stored.
//   6. recordCriticalWriteEvent.
//   7. Return { ok: true }.
//
// Activation prerequisites (document — DO NOT apply automatically):
//   • Migration 20260601000000_arca_delegation applied to prod.
//   • Merchant completed the AFIP Administrador de Relaciones delegation step
//     (added Velora's provider CUIT as authorized representative for WSFE).
//   • Velora's operator cert provisioned in GCS + Secret Manager:
//       VELORA_PROVIDER_CERT_GCS_PATH  — GCS object name for Velora's .p12 cert.
//       VELORA_PROVIDER_PASSPHRASE_SECRET — Secret Manager secretId for the passphrase.
//       VELORA_PROVIDER_CUIT           — Velora's provider CUIT (informational, captured here).
//   • ARCA_REAL_MODE=true set in Cloud Run env.
//
// Security: NOT auth-exempt. Goes through standard owner resolveActor.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  jsonError,
  internalError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";
import { evictTicket } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsaa";

const MUTATION_ACTIONS = {
  POST: "arca_credential.connect_delegation",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

const VALID_CONDICION_IVA = new Set(["RI", "MT", "EX", "CF"]);

export async function POST(req: NextRequest) {
  // ── 1. Auth: owner only ──────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  // ── 2. Rate limit ────────────────────────────────────────────────────────
  const rateLimited = checkRateLimit(req, "delegation-connect", 10, 60, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;
  void ACTION_META;

  // ── 3. Parse + validate JSON body ───────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("INVALID_BODY", "Se esperaba un body JSON.", 400);
  }

  if (typeof body !== "object" || body === null) {
    return jsonError("INVALID_BODY", "Body inválido.", 400);
  }

  const { puntoVenta, condicionIva } = body as Record<string, unknown>;

  if (typeof puntoVenta !== "number" || !Number.isInteger(puntoVenta) || puntoVenta < 1) {
    return jsonError("INVALID_PUNTO_VENTA", "puntoVenta debe ser un número entero mayor a 0.", 400);
  }

  if (typeof condicionIva !== "string" || !VALID_CONDICION_IVA.has(condicionIva)) {
    return jsonError(
      "INVALID_CONDICION_IVA",
      "condicionIva debe ser uno de: RI, MT, EX, CF.",
      400,
    );
  }

  // ── 4. Load merchant CUIT from Business row ──────────────────────────────
  let business: { cuit: string | null } | null;
  try {
    business = await prisma.business.findUnique({
      where: { id: ctx.businessId },
      select: { cuit: true },
    });
  } catch (err) {
    logRouteError("integrations/fiscal/connect-delegation", err, { stage: "business_load" });
    return internalError("Error al leer datos del negocio.");
  }

  const cuit = business?.cuit?.replace(/\D/g, "") ?? "";
  if (!cuit) {
    return jsonError(
      "MISSING_CUIT",
      "Configurá tu CUIT en el chat antes de activar la delegación fiscal.",
      422,
    );
  }

  // ── 5. Upsert ArcaCredential (delegation row) ───────────────────────────
  // certGcsPath and passphraseSecretName are left empty — the provider cert is
  // resolved at emit time from VELORA_PROVIDER_CERT_GCS_PATH + _PASSPHRASE_SECRET.
  // environment defaults to "production" (delegation is only meaningful in prod).
  const providerCuit = process.env.VELORA_PROVIDER_CUIT ?? null;
  try {
    await prisma.arcaCredential.upsert({
      where: { businessId: ctx.businessId },
      create: {
        businessId: ctx.businessId,
        cuit,
        puntoVenta,
        condicionIva,
        certGcsPath: "", // no per-merchant cert in delegation mode
        isProviderDelegation: true,
        providerCuit,
        environment: "production",
      },
      update: {
        cuit,
        puntoVenta,
        condicionIva,
        isProviderDelegation: true,
        providerCuit,
        // Clear legacy cert fields in case this business previously used own-cert mode.
        certGcsPath: "",
        encryptedPassphrase: null,
        passphraseSecretName: null,
        environment: "production",
      },
    });
  } catch (err) {
    logRouteError("integrations/fiscal/connect-delegation", err, { stage: "db_upsert" });
    return internalError("No se pudo guardar la configuración. Intentá de nuevo.");
  }

  // Evict any stale WSAA ticket so the next emission uses the provider cert immediately.
  evictTicket(ctx.businessId);

  // ── 6. Audit event ───────────────────────────────────────────────────────
  await recordCriticalWriteEvent({
    client: prisma,
    businessId: ctx.businessId,
    actorUserId: ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope: "integrations/fiscal/connect-delegation",
    actionType: "arca_credential.connect_delegation",
    resourceType: "arca_credential",
    resourceId: ctx.businessId,
    summary: "Delegación fiscal ARCA activada",
    payload: { puntoVenta, condicionIva, providerCuit },
  });

  return NextResponse.json({ ok: true });
}
