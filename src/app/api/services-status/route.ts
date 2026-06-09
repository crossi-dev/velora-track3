import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  // Resolve actor BEFORE the rate-limit check so tester accounts (e.g. owner
  // testing the new tab repeatedly) can bypass the per-IP limit. The route is
  // owner-only so actor resolution must happen anyway.
  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json(
      { code: "UNAUTHORIZED", message: "Authentication required." },
      { status: 401 },
    );
  }
  const forbidden = requireRole(actor, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(actor));
  if (rateLimited) return rateLimited;

  const { businessId } = actor;

  try {
    const [business, mpConnection, modoConnection, arcaCredential, andreani, oca, correo, employeeCount] =
      await Promise.all([
        prisma.business.findUnique({
          where: { id: businessId },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- whatsappBusinessPhoneE164 and wabaConnection are new schema fields; Prisma client regen is blocked on shared node_modules DLL lock in worktree. Cast until next full generate.
          select: { alias: true, whatsappBusinessPhoneE164: true, wabaConnection: { select: { id: true } } } as any,
        }) as Promise<{ alias: string | null; whatsappBusinessPhoneE164: string | null; wabaConnection: { id: string } | null } | null>,
        prisma.mpConnection.findUnique({ where: { businessId } }),
        prisma.modoConnection.findUnique({ where: { businessId } }),
        prisma.arcaCredential.findUnique({ where: { businessId } }),
        prisma.courierCredential.findFirst({
          where: { businessId, provider: "andreani" },
        }),
        prisma.courierCredential.findFirst({
          where: { businessId, provider: "oca" },
        }),
        prisma.courierCredential.findFirst({
          where: { businessId, provider: "correo" },
        }),
        prisma.employee.count({ where: { businessId, active: true } }),
      ]);

    // WhatsApp Business connection status — two-tier signal:
    //   whatsapp_business=true  → full WabaConnection exists (Meta Embedded Signup complete)
    //   whatsapp_phone=true     → lower-tier: only E.164 phone is set (pre-Embedded-Signup)
    // Source — Stripe Incremental currently_due pattern (show what's needed now):
    //   https://docs.stripe.com/connect/custom/hosted-onboarding
    const wabaConnected = !!(business as { wabaConnection?: { id: string } | null } | null)?.wabaConnection;
    const waPhoneSet = !!((business as { whatsappBusinessPhoneE164?: string | null } | null)?.whatsappBusinessPhoneE164?.trim());
    const whatsappConnected = wabaConnected || waPhoneSet;

    return NextResponse.json({
      supervisor: { status: "active" },
      companion: { status: "active", employeeCount },
      whatsapp_business: {
        providers: [
          {
            id: "whatsapp_business",
            label: "WhatsApp Business",
            connected: whatsappConnected,
            // Distinguish full WABA vs lighter phone-only capture in the UI.
            value: wabaConnected ? "waba" : (waPhoneSet ? "phone" : undefined),
          },
        ],
      },
      fiscal: {
        providers: [
          {
            id: "arca",
            label: "AFIP/ARCA",
            connected: !!arcaCredential,
            connectAction: { type: "open_settings", panel: "negocio.fiscal" },
          },
        ],
      },
      ventas: {
        providers: [
          {
            id: "mercadopago",
            label: "Mercado Pago",
            connected: !!mpConnection,
            ...(mpConnection?.expiresAt
              ? { expiresAt: mpConnection.expiresAt.toISOString() }
              : {}),
            connectAction: {
              type: "open_settings",
              panel: "negocio.mercadopago",
            },
          },
          {
            id: "modo",
            label: "MODO",
            connected: !!modoConnection,
            connectAction: { type: "open_settings", panel: "negocio.modo" },
          },
          {
            id: "alias",
            label: "Alias/CBU",
            connected: !!(business?.alias && business.alias.trim().length > 0),
            ...(business?.alias ? { value: business.alias } : {}),
          },
        ],
      },
      logistica: {
        providers: [
          {
            id: "andreani",
            label: "Andreani",
            connected: !!andreani,
            connectAction: {
              type: "open_settings",
              panel: "logistica.andreani",
            },
          },
          {
            id: "oca",
            label: "OCA",
            connected: !!oca,
            connectAction: { type: "open_settings", panel: "logistica.oca" },
          },
          {
            id: "correo",
            label: "Correo Argentino",
            connected: !!correo,
            connectAction: {
              type: "open_settings",
              panel: "logistica.correo",
            },
          },
        ],
      },
    });
  } catch (error) {
    logRouteError("services-status:GET", error);
    return NextResponse.json(
      {
        code: "SERVICES_STATUS_FAILED",
        message: "Failed to load services status.",
      },
      { status: 500 },
    );
  }
}
