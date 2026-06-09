// POST /api/integrations/fiscal/connect — owner-only.
//
// Accepts a multipart/form-data body with:
//   cert        — the owner's PKCS#12 (.p12) file
//   passphrase  — the cert password (plain text; stored in Secret Manager)
//   environment — "production" | "homo" (default: "production")
//                 The AFIP environment this cert is registered for.
//                 Homologación certs only work against AFIP's test servers;
//                 production certs only work against the live production servers.
//
// Flow:
//   1. Auth: resolveActor + requireRole(owner).
//   2. Rate limit (upload bucket — 10 req/min).
//   3. Parse multipart body; validate presence of cert + passphrase.
//   4. Local validation: verify passphrase unlocks the .p12 (no network).
//   5. Load business CUIT from DB (needed for WSAA preflight).
//   6. WSAA preflight: attempt a real AFIP production login with the cert buffer.
//        If WSAA rejects → 422 with actionable Spanish message. Nothing stored.
//        If WSAA succeeds → the cert is proven to work for real AFIP auth.
//   7. Upload cert buffer → gs://{ARCA_CERT_BUCKET}/{businessId}.p12.
//   8. Store passphrase in Secret Manager as velora-arca-passphrase-{businessId}.
//   9. Upsert ArcaCredential row with certGcsPath + passphraseSecretName + environment.
//        encryptedPassphrase is cleared on new/rotated credentials (null).
//   10. Return { ok: true }.
//
// Security notes:
//   - The .p12 buffer is NEVER logged, returned, or stored in plaintext.
//   - The passphrase is NEVER logged or returned; it goes directly to Secret Manager.
//   - The passphrase validation step does NOT surface the passphrase in errors.
//   - Secret Manager IAM: Cloud Run SA needs roles/secretmanager.secretVersionAdder.

import { NextRequest, NextResponse } from "next/server";
import { createPrivateKey } from "node:crypto";
import {
  bypassIfTester,
  checkRateLimitUpload,
  jsonError,
  internalError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";
import { storeTenantSecret } from "@/lib/secret-manager-tenant";
import { uploadCertToGcs, deleteCertFromGcs } from "./_lib/cert-uploader";
import { validateCertAgainstWsaa, WsaaPreflightError } from "./_lib/wsaa-preflight";
import { evictTicket } from "@/app/api/agents/fiscal/jsonrpc/_lib/arca-real/wsaa";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";

const MUTATION_ACTIONS = {
  POST: "arca_credential.upsert",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

const MAX_CERT_BYTES = 256 * 1024; // 256 kB — .p12 files are typically < 10 kB

export async function POST(req: NextRequest) {
  // ── 1. Auth: owner only ──────────────────────────────────────────────────
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  // ── 2. Rate limit ────────────────────────────────────────────────────────
  const rateLimited = checkRateLimitUpload(req, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;
  void ACTION_META;

  // ── 3. Parse multipart body ──────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError("INVALID_BODY", "Expected multipart/form-data with cert + passphrase fields.", 400);
  }

  const certFile = formData.get("cert");
  const passphrase = formData.get("passphrase");
  const rawEnvironment = formData.get("environment") ?? "production";
  // Validate environment — only "production" or "homo" are accepted.
  // Silently defaulting to "production" was hiding misconfiguration; reject anything else.
  if (rawEnvironment !== "production" && rawEnvironment !== "homo") {
    return jsonError(
      "INVALID_ENVIRONMENT",
      "El campo 'environment' debe ser \"production\" o \"homo\".",
      400,
    );
  }
  const environment = rawEnvironment as "production" | "homo";

  if (!(certFile instanceof File)) {
    return jsonError("MISSING_CERT", "Campo 'cert' requerido (certificado de AFIP).", 400);
  }
  if (typeof passphrase !== "string" || passphrase.trim() === "") {
    return jsonError("MISSING_PASSPHRASE", "Campo 'passphrase' requerido.", 400);
  }
  if (certFile.size > MAX_CERT_BYTES) {
    return jsonError("CERT_TOO_LARGE", `El certificado no puede superar ${MAX_CERT_BYTES / 1024} kB.`, 400);
  }
  if (!certFile.name.toLowerCase().endsWith(".p12")) {
    return jsonError("INVALID_CERT_FORMAT", "El archivo seleccionado no es un certificado de AFIP válido.", 400);
  }

  const p12Buffer = Buffer.from(await certFile.arrayBuffer());

  // ── 4. Validate passphrase unlocks the .p12 (local, no network) ─────────
  // We attempt to parse the private key — this is the same logic cert-loader.ts
  // uses. A wrong passphrase or malformed .p12 throws before anything is stored.
  try {
    createPrivateKey({
      key: p12Buffer,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node doesn't expose pkcs12 format yet; valid at runtime in Node 22+
      format: "pkcs12" as any,
      passphrase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opts type narrower than runtime API; pkcs12 is valid at runtime
    } as any);
  } catch {
    // DO NOT surface internal error details — they may hint at passphrase content.
    return jsonError(
      "INVALID_CERT_OR_PASSPHRASE",
      "No se pudo abrir el certificado con la contraseña proporcionada. Verificá que el certificado de AFIP y la contraseña sean correctos.",
      422,
    );
  }

  // ── 5. Load business CUIT (needed for WSAA preflight) ────────────────────
  let business: { cuit: string | null; ivaCondition: string | null; puntoVenta: string | null } | null;
  try {
    business = await prisma.business.findUnique({
      where: { id: ctx.businessId },
      select: { cuit: true, ivaCondition: true, puntoVenta: true },
    });
  } catch (err) {
    logRouteError("integrations/fiscal/connect", err, { stage: "business_load" });
    return internalError("Error al leer datos del negocio.");
  }

  const cuit = business?.cuit ?? "";

  // ── 5b. Guard: CUIT must be set before attempting WSAA ───────────────────
  // An empty CUIT causes an opaque SOAP fault from WSAA that surfaces as
  // "Probá de nuevo". Catch it here with an actionable 422 instead.
  if (!cuit || cuit.replace(/\D/g, "").length === 0) {
    return jsonError(
      "MISSING_CUIT",
      "Configurá tu CUIT en el chat antes de subir el certificado.",
      422,
    );
  }

  // ── 6. WSAA preflight — validate cert against AFIP production ────────────
  // The cert buffer is used here in memory only. If this fails, nothing is
  // uploaded to GCS and no DB row is created/updated.
  try {
    await validateCertAgainstWsaa(p12Buffer, passphrase, cuit, environment);
  } catch (err) {
    if (err instanceof WsaaPreflightError) {
      return jsonError("WSAA_PREFLIGHT_FAILED", err.spanishMessage, 422);
    }
    // Unexpected error — treat as transient.
    logRouteError("integrations/fiscal/connect", err, { stage: "wsaa_preflight" });
    return jsonError(
      "WSAA_PREFLIGHT_FAILED",
      "No pudimos verificar el certificado con AFIP en este momento. Probá de nuevo.",
      422,
    );
  }

  // ── 7. Upload .p12 to GCS ─────────────────────────────────────────────────
  // Only reached when the cert is proven to work against AFIP production.
  let objectName: string;
  try {
    objectName = await uploadCertToGcs(ctx.businessId, p12Buffer);
  } catch (err) {
    logRouteError("integrations/fiscal/connect", err, { stage: "gcs_upload" });
    return internalError("No se pudo subir el certificado. Intentá de nuevo.");
  }

  // ── 8. Store passphrase in Secret Manager ───────────────────────────────
  // The passphrase never touches the DB — only the Secret Manager secret ID
  // (a non-sensitive path string) is persisted. If this step fails, nothing
  // has been written to the DB yet, so the operation is still atomic.
  let passphraseSecretName: string;
  try {
    passphraseSecretName = await storeTenantSecret({
      businessId: ctx.businessId,
      name: "arca-passphrase",
      value: passphrase,
    });
  } catch (err) {
    logRouteError("integrations/fiscal/connect", err, { stage: "secret_manager_store" });
    // Best-effort GCS cleanup — cert was uploaded but Secret Manager failed.
    await deleteCertFromGcs(objectName).catch((cleanupErr) => {
      logRouteError("integrations/fiscal/connect", cleanupErr, { stage: "gcs_cleanup_after_sm_fail" });
    });
    return internalError("No se pudo guardar la credencial de forma segura. Intentá de nuevo.");
  }

  // ── 9. Upsert ArcaCredential ─────────────────────────────────────────────
  // Business fields already loaded in step 5; cuit resolved above.
  // Normalize ivaCondition from long-form (stored on Business) to the short
  // code required by ArcaCredential / emit-invoice loadCredential validation.
  // Business.ivaCondition may be "Monotributista", "Responsable Inscripto",
  // "Exento", or "Consumidor Final"; ArcaCredential.condicionIva expects
  // "MT", "RI", "EX", or "CF". Both short codes and unknown values pass
  // through unchanged so existing data is not broken.
  const IVA_LONG_TO_SHORT: Record<string, string> = {
    monotributista: "MT",
    "responsable inscripto": "RI",
    exento: "EX",
    "consumidor final": "CF",
  };
  const rawIvaCondition = business?.ivaCondition ?? "";
  const condicionIva =
    IVA_LONG_TO_SHORT[rawIvaCondition.toLowerCase().trim()] ?? rawIvaCondition;
  const puntoVenta = parseInt(business?.puntoVenta ?? "0", 10);

  const credentialData = {
    cuit,
    condicionIva,
    puntoVenta,
    certGcsPath: objectName,
    // Store only the non-sensitive secret ID — the passphrase itself lives in
    // Secret Manager, never in the DB.
    passphraseSecretName,
    // Clear legacy field on create/rotate so the loader always uses Secret Manager.
    encryptedPassphrase: null,
    environment,
  };

  try {
    await prisma.arcaCredential.upsert({
      where: { businessId: ctx.businessId },
      create: { businessId: ctx.businessId, ...credentialData },
      update: credentialData,
    });
  } catch (err) {
    logRouteError("integrations/fiscal/connect", err, { stage: "db_upsert" });
    // Best-effort GCS cleanup — the cert was uploaded but the DB row failed,
    // so the object would be unreachable (orphaned). Ignore cleanup errors; ops
    // can run a periodic bucket scan to catch any remaining orphans.
    await deleteCertFromGcs(objectName).catch((cleanupErr) => {
      logRouteError("integrations/fiscal/connect", cleanupErr, { stage: "gcs_cleanup_after_upsert_fail" });
    });
    return internalError("No se pudo guardar la credencial. Intentá de nuevo.");
  }

  // Evict any cached WSAA ticket so the next emission uses the new cert immediately.
  // Without this, a rotated cert leaves the old ticket in-memory for up to 12 h,
  // causing WSAA 601 errors until it naturally expires.
  evictTicket(ctx.businessId);

  await recordCriticalWriteEvent({
    client: prisma,
    businessId: ctx.businessId,
    actorUserId: ctx.actorUserId,
    actorEmployeeId: ctx.actorEmployeeId,
    routeScope: "integrations/fiscal/connect",
    actionType: "arca_credential.upsert",
    resourceType: "arca_credential",
    resourceId: ctx.businessId,
    summary: "Credencial ARCA actualizada",
    payload: { certFileName: certFile.name, certSizeBytes: certFile.size, environment },
  });

  return NextResponse.json({ ok: true });
}
