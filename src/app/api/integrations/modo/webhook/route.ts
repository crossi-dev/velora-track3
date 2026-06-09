// POST /api/integrations/modo/webhook — MODO payment status callback.
//
// MODO calls this URL when a payment intention changes status.
// We register this URL with MODO via PATCH /middleman/ on the SDK side.
//
// Payload shape (from open-source WP plugin Orders/Webhooks.php):
//   { id: string, external_intention_id: string, status: "ACCEPTED"|"REJECTED"|"CANCELLED" }
//
// external_intention_id = "{businessId}:{paymentIntentId}" (set at creation time)
//
// Security:
//   - Bearer token: requires "Authorization: Bearer <MODO_WEBHOOK_SECRET>" header.
//     Verified with timingSafeEqual (constant-time). Fail-closed if env var absent.
//   - Rate-limited (20/60s per IP) to resist flood attacks.
//   - Always returns 200 to MODO to suppress retries — idempotency is handled
//     by checking current DB status before updating.
//
// Allowlist: /api/integrations/modo/webhook is in AUTH_EXEMPT_PREFIXES via
// the "integrations" prefix path — no auth session needed.

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { prisma } from "@/lib/prisma";
import {
  getServerActionMeta,
  type RouteMutationDeclaration,
} from "@/app/api/_lib/mutation-contract";
import { confirmPaymentIntentUseCase } from "@/app/api/payment-intents/_lib/payment-intent-use-case";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { pushOnConfirm } from "../../mp/_lib/webhook-push";
import { verifyModoBearer, mapModoStatus } from "./_lib/modo-webhook-helpers";

// System-initiated - no user session. MODO POSTs here on payment status change.
const MUTATION_ACTIONS = {
  POST: "payment_intent.webhook_update",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

interface ModoWebhookPayload {
  id?: string | number;
  external_intention_id?: string;
  status?: string;
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  void ACTION_META;

  const authResult = verifyModoBearer(req);
  if (!authResult.ok) {
    const ip = getClientIp(req.headers);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MODO_WEBHOOK_AUTH_FAILED",
      a2a_transfer: false,
      message: `MODO webhook rejected - ${authResult.reason ?? "auth_failed"}`,
      data: { ip, reason: authResult.reason },
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimited = checkRateLimit(req, "modo-webhook", 20, 60);
  if (rateLimited) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MODO_WEBHOOK_RATE_LIMITED",
      a2a_transfer: false,
      message: "MODO webhook rate-limit hit - returning 200 to suppress retries",
    });
    return NextResponse.json({ ok: true, ignored: "rate_limited" });
  }

  let payload: ModoWebhookPayload | null = null;
  try {
    payload = (await req.json()) as ModoWebhookPayload;
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MODO_WEBHOOK_INVALID_JSON",
      a2a_transfer: false,
      message: "MODO webhook body no es JSON parseable",
    });
    return NextResponse.json({ ok: true, ignored: "invalid_json" });
  }

  const modoId = payload?.id != null ? String(payload.id).trim() : "";
  const externalRef = typeof payload?.external_intention_id === "string"
    ? payload.external_intention_id.trim()
    : "";
  const modoStatus = typeof payload?.status === "string" ? payload.status.trim() : "";

  if (!modoId || !externalRef || !modoStatus) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MODO_WEBHOOK_MISSING_FIELDS",
      a2a_transfer: false,
      message: "MODO webhook: payload incompleto",
      data: { hasId: !!modoId, hasRef: !!externalRef, hasStatus: !!modoStatus },
    });
    return NextResponse.json({ ok: true, ignored: "missing_fields" });
  }

  const separatorIdx = externalRef.indexOf(":");
  if (separatorIdx < 1) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MODO_WEBHOOK_BAD_REF",
      a2a_transfer: false,
      message: "MODO webhook: external_intention_id sin separador ':'",
      data: { externalRef },
    });
    return NextResponse.json({ ok: true, ignored: "bad_external_ref" });
  }

  const businessId = externalRef.slice(0, separatorIdx);
  const paymentIntentId = externalRef.slice(separatorIdx + 1);

  if (!businessId || !paymentIntentId) {
    return NextResponse.json({ ok: true, ignored: "bad_external_ref_parts" });
  }

  const mappedStatus = mapModoStatus(modoStatus);
  if (!mappedStatus) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "MODO_WEBHOOK_UNKNOWN_STATUS",
      a2a_transfer: false,
      message: `MODO webhook: status desconocido "${modoStatus}" - ignorado`,
      data: { modoId, businessId, paymentIntentId },
    });
    return NextResponse.json({ ok: true, ignored: `unknown_status=${modoStatus}` });
  }

  try {
    if (mappedStatus.approved) {
      const intentRow = await prisma.paymentIntent.findFirst({
        where: { id: paymentIntentId, businessId },
        select: { matchedCustomerId: true, createdByEmployeeId: true, monto: true },
      });
      let customerName: string | null = null;
      // findFirst with businessId: defense-in-depth tenant guard on customer PII.
      if (intentRow?.matchedCustomerId) {
        const customer = await prisma.customer.findFirst({
          where: { id: intentRow.matchedCustomerId, businessId },
          select: { name: true },
        });
        customerName = customer?.name ?? null;
      }

      const result = await confirmPaymentIntentUseCase({
        businessId,
        actorUserId: "system-modo-webhook",
        actorEmployeeId: null,
        paymentIntentId,
        idempotencyKey: `modo-webhook-${modoId}`,
      });

      cloudLog({
        severity: "INFO",
        component: "System",
        action: "MODO_WEBHOOK_PROCESSED",
        a2a_transfer: false,
        message: `MODO webhook processed: estado=confirmed, outcome=${result.outcome}`,
        data: { modoId, businessId, paymentIntentId, modoStatus, outcome: result.outcome },
      });

      if (result.outcome === "confirmed" && intentRow) {
        pushOnConfirm({
          businessId,
          paymentIntentId,
          monto: Number(intentRow.monto),
          createdByEmployeeId: intentRow.createdByEmployeeId ?? null,
          customerName,
        });
      }
    } else {
      const { count } = await prisma.paymentIntent.updateMany({
        where: { id: paymentIntentId, businessId },
        data: { estado: mappedStatus.estado, providerRef: modoId },
      });

      if (count > 0) {
        await recordCriticalWriteEvent({
          client: prisma,
          businessId,
          actorUserId: "system-modo-webhook",
          actorEmployeeId: null,
          routeScope: ACTION_META.routeScope,
          actionType: "payment_intent.cancel",
          resourceType: ACTION_META.resourceType,
          resourceId: paymentIntentId,
          summary: `MODO payment intent ${mappedStatus.estado} via webhook (modoId=${modoId})`,
          payload: { modoId, modoStatus, veleraEstado: mappedStatus.estado },
        });
      }

      cloudLog({
        severity: "INFO",
        component: "System",
        action: "MODO_WEBHOOK_PROCESSED",
        a2a_transfer: false,
        message: `MODO webhook processed: estado=${mappedStatus.estado}, rowsUpdated=${count}`,
        data: { modoId, businessId, paymentIntentId, modoStatus, veleraEstado: mappedStatus.estado },
      });

      if (count === 0) {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "MODO_WEBHOOK_NO_ROWS_UPDATED",
          a2a_transfer: false,
          message: "MODO webhook: updateMany afecto 0 filas",
          data: { paymentIntentId, businessId },
        });
      }
    }
  } catch (err: unknown) {
    logRouteError("integrations/modo/webhook", err);
    return NextResponse.json({ ok: true, ignored: "internal_error" });
  }

  return NextResponse.json({ ok: true });
}

export function POST(req: NextRequest): Promise<NextResponse> {
  return runWithTraceContext(req.headers, () => handlePost(req));
}
