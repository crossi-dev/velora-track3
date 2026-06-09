// emit-invoice.ts — ARCA real emission router.
//
// Routes invoice emission to the real ARCA/AFIP pipeline or the sandbox mock
// based on two conditions:
//   1. ARCA_REAL_MODE=true env var.
//   2. An ArcaCredential row exists in the DB for the given businessId.
//
// If either condition is false → falls back to sandbox (current behavior).
//
// To activate real mode:
//   1. Set ARCA_REAL_MODE=true in Cloud Run env (or .env.local).
//   2. Insert an ArcaCredential row for the business.
//   3. Upload the .p12 cert to gs://{ARCA_CERT_BUCKET}/{businessId}.p12.

import { prisma } from "@/lib/prisma";
import { decrypt } from "@velora/core-utils/mp-token-cipher";
import { getTenantSecret } from "@/lib/secret-manager-tenant";
import { cloudLog } from "@/lib/cloud-logger";
import { getTicket, evictTicket } from "./wsaa";
import { emitInvoice as wsfeEmitInvoice } from "./wsfe";
import type { ArcaCredential, CbteAsoc, EmitInvoiceInput, EmitInvoiceResult } from "./types";

// ── IVA split helper (pure, unit-testable) ────────────────────────────────────

/**
 * Splits a 21%-IVA-inclusive total into { neto, iva } such that neto + iva === total exactly.
 * Uses integer-cent rounding to avoid floating-point drift that AFIP rejects (error 10016).
 *
 * Strategy: round neto DOWN to 2 decimal places, then assign the remainder to iva.
 * This guarantees neto + iva === total at the cent level.
 */
export function splitIva21(total: number): { neto: number; iva: number } {
  // Integer-cent arithmetic: ensures neto + iva === total exactly at the cent level.
  // AFIP rejects invoices where ImpNeto + ImpIVA ≠ ImpTotal (error 10016).
  const totalCents = Math.round(total * 100);
  const netoCents = Math.round(totalCents / 1.21);
  const ivaCents = totalCents - netoCents;
  return { neto: netoCents / 100, iva: ivaCents / 100 };
}

// ── Sandbox mock (preserves existing behavior) ────────────────────────────────

export interface SandboxInvoiceResult {
  sandbox: true;
  cae: string;
  vencimiento: string;
  tipo: "A" | "B" | "C";
  numero: number;
  customerCuit: string;
  amountARS: number;
  concept: string;
  /**
   * Set to true when ARCA_REAL_MODE=true but no ArcaCredential row exists.
   * Signals a misconfiguration, not a normal sandbox emission.
   * Callers can use this to surface a warning instead of a silent fake invoice.
   */
  misconfigured?: true;
}

export function sandboxEmit(params: {
  customerCuit: string;
  amountARS: number;
  tipo: "A" | "B" | "C";
  concept?: string;
  /** Business IVA condition — used to enforce Monotributista → type C, mirroring real path. */
  condicionIva?: string | null;
  /** When present, the sandbox result reflects a NC/ND rather than a plain invoice. */
  noteKind?: "credito" | "debito";
}): SandboxInvoiceResult {
  const ts = Date.now();
  const cae = String(ts).slice(-14).padStart(14, "0");
  const venc = new Date(ts + 10 * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  // Apply the same type correction as the real path — sandbox must not lie about what real mode emits.
  const correctedTipo = resolveInvoiceType(params.tipo, params.condicionIva);
  // Use a timestamp-derived numero so multiple sandbox emissions within a demo session
  // produce distinct comprobante numbers (Factura C N°xxxxx) rather than all showing N°1.
  // Modulo 100_000 keeps it in a realistic invoice-number range (< 100k) without
  // implying real AFIP sequential numbering. The ts variable already captures Date.now()
  // above — reuse it rather than calling Date.now() again.
  // Analogy: Stripe sandbox charges get distinct IDs even though none are real.
  const sandboxNumero = ts % 100_000;
  return {
    sandbox: true,
    cae,
    vencimiento: venc,
    tipo: correctedTipo,
    numero: sandboxNumero,
    customerCuit: params.customerCuit,
    amountARS: params.amountARS,
    concept: params.concept ?? "Productos y/o servicios",
  };
}

// ── Credential loader ─────────────────────────────────────────────────────────

async function loadCredential(
  businessId: string,
  isProduction: boolean,
): Promise<ArcaCredential | null> {
  const row = await prisma.arcaCredential.findUnique({
    where: { businessId },
    select: {
      businessId: true,
      cuit: true,
      puntoVenta: true,
      condicionIva: true,
      certGcsPath: true,
      encryptedPassphrase: true,
      passphraseSecretName: true,
      environment: true,
      isProviderDelegation: true,
    },
  });
  if (!row) return null;

  const VALID_CONDICION_IVA = new Set(["RI", "MT", "EX", "CF"]);
  if (!VALID_CONDICION_IVA.has(row.condicionIva)) {
    throw new Error(
      `[emit-invoice] condicionIva inválida en ArcaCredential para businessId=${row.businessId}: ` +
        `"${row.condicionIva}". Valores permitidos: RI, MT, EX, CF.`,
    );
  }

  // ── Delegation path: Velora's provider cert signs WSAA; merchant CUIT in WSFE ─
  // The merchant delegated the WSFE service to Velora's provider CUIT via AFIP
  // Administrador de Relaciones. No per-merchant cert is stored — cert + passphrase
  // come from Velora's own env vars. row.cuit (merchant CUIT) is kept as-is and
  // forwarded to WSFE <ar:Cuit> as the represented party.
  //
  // Activation prerequisites (cannot be end-to-end tested until these are set):
  //   VELORA_PROVIDER_CERT_GCS_PATH — GCS object name for Velora's PKCS#12 provider cert.
  //   VELORA_PROVIDER_PASSPHRASE_SECRET — Secret Manager secretId for the cert passphrase.
  //       Resolved via getTenantSecret({ businessId: "velora-provider", name: <secretId> })
  //       → key "velora-{secretId}-velora-provider". Provision Velora's AFIP cert in GCS
  //       and the passphrase in Secret Manager before setting these env vars.
  if (row.isProviderDelegation) {
    const providerCertPath = process.env.VELORA_PROVIDER_CERT_GCS_PATH;
    const providerPassphraseSecret = process.env.VELORA_PROVIDER_PASSPHRASE_SECRET;
    if (!providerCertPath || !providerPassphraseSecret) {
      throw new Error(
        "La facturación electrónica por delegación aún no está habilitada. " +
          "El administrador de Velora debe configurar el certificado proveedor " +
          "(VELORA_PROVIDER_CERT_GCS_PATH y VELORA_PROVIDER_PASSPHRASE_SECRET) " +
          "antes de activar este negocio.",
      );
    }
    // Reuse getTenantSecret with a fixed synthetic businessId so the lookup key is
    // deterministic: velora-{providerPassphraseSecret}-velora-provider.
    const passphrase = await getTenantSecret({
      businessId: "velora-provider",
      name: providerPassphraseSecret,
    });
    return {
      businessId: row.businessId,
      cuit: row.cuit, // merchant CUIT — goes into WSFE <ar:Cuit> as represented party
      puntoVenta: row.puntoVenta,
      condicionIva: row.condicionIva as ArcaCredential["condicionIva"],
      certGcsPath: providerCertPath, // Velora's cert — signs WSAA
      passphrase,
    };
  }

  // ── Standard path: per-merchant cert ────────────────────────────────────────
  // H2 guard: if the operator set ARCA_PRODUCTION=true but the cert stored in the
  // DB is a homologation certificate, WSAA will return a 601 and retry-loop endlessly.
  // Fail fast with a human-readable error instead of burning retries against AFIP.
  if (isProduction && row.environment === "homo") {
    throw new Error(
      "Tu certificado ARCA es de homologación y no podés usarlo en producción. " +
        "Subí el certificado de producción en Ajustes → Fiscal.",
    );
  }

  // Resolve passphrase: Secret Manager (current) → AES-256-GCM DB field (legacy fallback).
  // The fallback is intentional — it keeps existing credentials working until the
  // migration script (scripts/migrate-arca-passphrase-to-secret-manager.mjs) runs.
  let passphrase: string;
  if (row.passphraseSecretName) {
    passphrase = await getTenantSecret({
      businessId: row.businessId,
      name: "arca-passphrase",
    });
  } else if (row.encryptedPassphrase) {
    passphrase = decrypt(row.encryptedPassphrase);
  } else {
    throw new Error(
      `[emit-invoice] ArcaCredential para businessId=${row.businessId} no tiene ` +
        "ni passphraseSecretName ni encryptedPassphrase. " +
        "Re-conectá el certificado ARCA desde Settings.",
    );
  }

  return {
    businessId: row.businessId,
    cuit: row.cuit,
    puntoVenta: row.puntoVenta,
    condicionIva: row.condicionIva as ArcaCredential["condicionIva"],
    certGcsPath: row.certGcsPath,
    passphrase,
  };
}

// ── Invoice type resolution (shared, pure) ───────────────────────────────────

/**
 * Resolves the effective invoice type given what the LLM requested and the
 * business's IVA condition. Monotributistas can ONLY emit Factura C — any
 * other request is silently corrected to C.
 *
 * condicionIva uses the short codes stored in ArcaCredential / Business:
 *   MT = Monotributista, RI = Responsable Inscripto, EX = Exento, CF = Consumidor Final
 * but also accepts the long-form strings stored on Business.ivaCondition
 * ("Monotributista", "Responsable Inscripto", etc.) for robustness.
 *
 * @returns The corrected invoice type ("A" | "B" | "C").
 */
export function resolveInvoiceType(
  tipoRequested: "A" | "B" | "C",
  condicionIva: string | null | undefined,
): "A" | "B" | "C" {
  const isMonotributo =
    condicionIva === "MT" || condicionIva?.toLowerCase().startsWith("monotrib");
  if (isMonotributo) return "C";
  return tipoRequested;
}

// ── Invoice type mapping ──────────────────────────────────────────────────────

/**
 * Maps the human-friendly tipo ("A" | "B" | "C") to the WSFE TipoComprobante code.
 * Monotributistas MUST use type C (11).
 */
function mapTipo(
  tipo: "A" | "B" | "C",
  condicionIva: ArcaCredential["condicionIva"],
): EmitInvoiceInput["tipoComprobante"] {
  // Monotributistas can only issue C invoices — enforce regardless of caller request
  if (condicionIva === "MT") return 11;
  if (tipo === "A") return 1;
  if (tipo === "B") return 6;
  return 11; // C
}

/**
 * Maps invoice letter + note kind to the WSFE NC/ND TipoComprobante code.
 * Monotributistas can only issue C notes (12/13) — enforced via condicionIva.
 *
 * Mapping per AFIP WSFE spec:
 *   A + credito → 3 (NC A), A + debito → 2 (ND A)
 *   B + credito → 8 (NC B), B + debito → 7 (ND B)
 *   C + credito → 13 (NC C), C + debito → 12 (ND C)
 */
function mapNoteTipo(
  tipo: "A" | "B" | "C",
  kind: "credito" | "debito",
  condicionIva: ArcaCredential["condicionIva"],
): EmitInvoiceInput["tipoComprobante"] {
  const effectiveTipo = condicionIva === "MT" ? "C" : tipo;
  if (effectiveTipo === "A") return kind === "credito" ? 3 : 2;
  if (effectiveTipo === "B") return kind === "credito" ? 8 : 7;
  return kind === "credito" ? 13 : 12; // C
}

// ── Main router ───────────────────────────────────────────────────────────────

export interface RealEmitParams {
  businessId: string;
  customerCuit: string;
  amountARS: number;
  tipo: "A" | "B" | "C";
  concept?: string;
  /** Business IVA condition — forwarded to sandboxEmit for type correction. Loaded from Business row. */
  condicionIva?: string | null;
  /**
   * When set, emits a Nota Crédito (credito) or Nota Débito (debito) instead of a plain invoice.
   * The WSFE tipoComprobante is derived from `tipo` + `noteKind` via mapNoteTipo.
   */
  noteKind?: "credito" | "debito";
  /**
   * Associated voucher — required by AFIP when noteKind is present.
   * Passed through to wsfeInput.cbteAsoc for the CbtesAsoc XML block.
   */
  cbteAsoc?: CbteAsoc;
}

export type EmitResult = SandboxInvoiceResult | EmitInvoiceResult;

/**
 * Emits an invoice — real or sandbox — based on ARCA_REAL_MODE + credential presence.
 *
 * Error handling: on auth failure (401-equivalent WSAA error), evicts the
 * cached ticket and retries once before re-throwing.
 */
export async function emit(params: RealEmitParams): Promise<EmitResult> {
  // Demo-tester gate: certain owner accounts always emit sandbox regardless
  // of ARCA_REAL_MODE — see src/lib/demo-testers.ts for the rationale.
  const { isBusinessDemoTester } = await import("@/lib/demo-testers");
  if (await isBusinessDemoTester(params.businessId)) {
    return sandboxEmit({ ...params, condicionIva: params.condicionIva, noteKind: params.noteKind });
  }
  const realMode = process.env.ARCA_REAL_MODE === "true";
  if (!realMode) {
    return sandboxEmit({ ...params, condicionIva: params.condicionIva, noteKind: params.noteKind });
  }

  // ARCA_PRODUCTION=true routes to the real AFIP production endpoint.
  // Declared before loadCredential so the flag can be passed into the credential
  // loader for the H2 environment cross-validation check.
  // Do NOT gate on NODE_ENV — Cloud Run does not set NODE_ENV=production by default.
  const isProduction = process.env.ARCA_PRODUCTION === "true";

  const credential = await loadCredential(params.businessId, isProduction);
  if (!credential) {
    // ARCA_REAL_MODE=true but no ArcaCredential row — misconfiguration, not normal sandbox.
    cloudLog({
      severity: "WARNING",
      component: "Fiscal",
      action: "ARCA_REAL_MODE_NO_CREDENTIAL",
      a2a_transfer: false,
      message: "ARCA real mode on but business has no credential — falling back to sandbox",
      businessId: params.businessId,
      data: {},
    });
    return { ...sandboxEmit({ ...params, condicionIva: params.condicionIva, noteKind: params.noteKind }), misconfigured: true };
  }

  const tipoComprobante = params.noteKind
    ? mapNoteTipo(params.tipo, params.noteKind, credential.condicionIva)
    : mapTipo(params.tipo, credential.condicionIva);

  // Build the WSFE input — for Monotributo (tipo C) IVA is zero.
  // AFIP validation: ImpTotal = ImpNeto + ImpIVA + ImpOpEx + ImpNoGrav + ImpTrib
  // ImpNeto is the net taxable base (before IVA), NOT the final total.
  // Monotributo = Factura C (11) AND Notas C (12=ND, 13=NC) — none carry IVA.
  // Omitting 12/13 sent a 21% IVA split on every MT note → AFIP error 10016 (JD finding).
  const isMonotributo = tipoComprobante === 11 || tipoComprobante === 12 || tipoComprobante === 13;
  // For 21% IVA: use splitIva21 to ensure neto + iva === total exactly (AFIP rejects drift).
  // For Monotributo (Factura C): ImpNeto = ImpTotal (the full amount IS the net — Monotributistas
  // do not charge IVA). ImpIVA = 0, ImpOpEx = 0. AFIP constraint: ImpTotal = ImpNeto + ImpIVA.
  // Sending neto=0 + total=X violates that constraint → AFIP error 10016.
  const { neto: netBase, iva: ivaAmount } = isMonotributo
    ? { neto: params.amountARS, iva: 0 }
    : splitIva21(params.amountARS);
  const wsfeInput: EmitInvoiceInput = {
    cuit: credential.cuit,
    puntoVenta: credential.puntoVenta,
    tipoComprobante,
    customerCuit: params.customerCuit ?? null,
    importeTotal: params.amountARS,
    importeNoGravado: 0,
    importeNeto: netBase,
    importeExento: 0,
    ivaItems: isMonotributo
      ? []
      : [
          {
            id: 5, // 21% IVA
            baseImponible: netBase,
            importe: ivaAmount,
          },
        ],
    concepto: 1, // Productos — Velora is product-only (physical franchises, no services). concepto 2/3 + service-period fields are out of scope.
    cbteAsoc: params.cbteAsoc,
  };

  // Attempt real emission, with one retry on auth failure
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ticket = await getTicket(credential, isProduction);
      return await wsfeEmitInvoice(wsfeInput, ticket, isProduction);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Auth-error detection uses regex with word boundaries / case-insensitive flags
      // to avoid false positives from substring matches (e.g. "12601" matching "601").
      // AFIP error codes covered:
      //   601 — CMSException: token inválido o expirado (WSAA)
      //   "Invalid Token" / "invalid token" — WSAA plain-text rejection variants
      //   "Token expirado" / "token expirado" — WSAA Spanish rejection message
      const isAuthError =
        /\b601\b/.test(msg) ||
        /invalid\s+token/i.test(msg) ||
        /token\s+expirado/i.test(msg);
      if (isAuthError && attempt === 1) {
        // Evict stale ticket and retry
        evictTicket(params.businessId);
        continue;
      }
      throw err;
    }
  }

  // TypeScript exhaustiveness guard — unreachable
  throw new Error("[emit-invoice] Unexpected state: loop exited without return or throw");
}
