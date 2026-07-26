"use client";

// TanStack Query source: https://tanstack.com/query/latest/docs/framework/react/overview
// Servicios status is cached for staleTime (30s) so revisiting the tab is instant.
// Modal close invalidates the query so the new connection state is shown immediately.

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionMarker } from "./v2/SectionMarker";
import { AgentCard, type ProviderStatus } from "./ServiciosTab.cards";
import { ConnectServiceModal } from "./ServiciosTab.connect-modal";
import {
  buildSupervisorMessage,
  type ConnectedServices,
} from "./ServiciosTab.copy";

interface ServiciosStatusResponse {
  supervisor: { status: string };
  companion: { status: string; employeeCount: number };
  fiscal: { providers: ProviderStatus[] };
  ventas: { providers: ProviderStatus[] };
  logistica: { providers: ProviderStatus[] };
  // Step 1.5c: WhatsApp Business tile — two-tier signal (waba or phone-only).
  // Source — Shopify Setup Guide composition: each integration is its own card.
  // https://shopify.dev/docs/apps/design/user-experience/onboarding
  whatsapp_business: { providers: ProviderStatus[] };
}

// Comunicaciones status is fetched directly from its own endpoint (not in
// /api/services-status aggregate) — same BYOA pattern as courier credentials.
interface ComunicacionesStatusResponse {
  twilio_sms: { connected: boolean };
  resend:     { connected: boolean };
  pedidosya:  { connected: boolean };
}

const COMUNICACIONES_QUERY_KEY = ["comunicaciones-status"] as const;

async function fetchComunicacionesStatus(): Promise<ComunicacionesStatusResponse> {
  const res = await fetch("/api/integrations/comunicaciones/status");
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return (await res.json()) as ComunicacionesStatusResponse;
}

// Comunicaciones = communication channels. WhatsApp Business is folded in here
// (it is a messaging channel) alongside SMS and email. PedidosYa is NOT here —
// it is a delivery courier and lives under Logística.
function comunicacionesToProviders(
  whatsappProviders: ProviderStatus[],
  data: ComunicacionesStatusResponse | undefined,
): ProviderStatus[] {
  return [
    ...whatsappProviders,
    { id: "twilio_sms", label: "Twilio SMS", connected: data?.twilio_sms.connected ?? false },
    { id: "resend",     label: "Resend",     connected: data?.resend.connected     ?? false },
  ];
}

// PedidosYa is a same-city last-mile courier — it belongs with the shipping
// providers under Logística, not under communication channels.
function pedidosYaProvider(
  data: ComunicacionesStatusResponse | undefined,
): ProviderStatus {
  return { id: "pedidosya", label: "PedidosYa", connected: data?.pedidosya.connected ?? false };
}

function SkeletonCard() {
  return (
    <div
      className="shimmer"
      style={{ height: "120px", borderRadius: "var(--radius-md)", width: "100%" }}
    />
  );
}

// companionSubtitle: SHELVED 2026-05-25 — Companion card hidden in this tab,
// helper unused. Restore alongside the AgentCard kind="companion" block below.

/** Extract connected-services map for the Supervisor message composer. */
function extractConnected(
  ventas: ProviderStatus[],
  fiscal: ProviderStatus[],
  logistica: ProviderStatus[],
): ConnectedServices {
  const find = (list: ProviderStatus[], id: string) =>
    list.find((p) => p.id === id)?.connected ?? false;

  return {
    mp: find(ventas, "mercadopago"),
    modo: find(ventas, "modo"),
    alias: find(ventas, "alias"),
    arca: find(fiscal, "arca"),
    andreani: find(logistica, "andreani"),
    oca: find(logistica, "oca"),
    correo: find(logistica, "correo"),
  };
}

const SERVICIOS_QUERY_KEY = ["services-status"] as const;

async function fetchServiciosStatus(): Promise<ServiciosStatusResponse> {
  const res = await fetch("/api/services-status");
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return (await res.json()) as ServiciosStatusResponse;
}

export function ServiciosTab() {
  const queryClient = useQueryClient();
  const [activeProvider, setActiveProvider] = useState<ProviderStatus | null>(null);

  const { data: status, isLoading: loading, error: queryError } = useQuery({
    queryKey: SERVICIOS_QUERY_KEY,
    queryFn: fetchServiciosStatus,
  });

  const { data: comunicacionesData } = useQuery({
    queryKey: COMUNICACIONES_QUERY_KEY,
    queryFn: fetchComunicacionesStatus,
  });

  const error = queryError instanceof Error ? queryError.message : null;

  const handleModalClose = useCallback(() => {
    setActiveProvider(null);
    void queryClient.invalidateQueries({ queryKey: SERVICIOS_QUERY_KEY });
  }, [queryClient]);

  const supervisorMsg = status
    ? buildSupervisorMessage(
        extractConnected(
          status.ventas.providers,
          status.fiscal.providers,
          status.logistica.providers,
        ),
      )
    : undefined;

  return (
    <div
      className="flex flex-col gap-4"
      style={{
        maxWidth: "640px",
        margin: "0 auto",
        width: "100%",
        paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))",
        paddingRight: "max(1rem, env(safe-area-inset-right, 0px))",
        boxSizing: "border-box",
      }}
    >
      <div className="flex flex-col gap-1.5">
        <SectionMarker label="System" number="08" />
        <h1
          className="t-display-3"
          style={{ color: "var(--tone-strong)", margin: 0 }}
        >
          Servicios
        </h1>
        <p
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.875rem",
            color: "var(--tone-muted)",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          Tus agentes y a qué servicios externos están conectados. Conectá tus
          cuentas — Velora las orquesta entre sí.
        </p>
      </div>

      {loading && (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {!loading && error && (
        <p
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.875rem",
            color: "var(--danger)",
          }}
        >
          No se pudo cargar el estado de los servicios. {error}
        </p>
      )}

      {!loading && !error && status && (
        <div className="flex flex-col gap-4">
          {/* Ventas — modo + alias SHELVED 2026-05-25 (MP OAuth only). */}
          <AgentCard
            kind="ventas"
            title="Tus cobros."
            subtitle="Cobra a tus clientes con QR, link de pago y transferencia."
            providers={status.ventas.providers.filter(
              (p) => !["modo", "alias"].includes(p.id),
            )}
            onProviderClick={setActiveProvider}
          />

          {/* Fiscal */}
          <AgentCard
            kind="fiscal"
            title="Tu contador."
            subtitle="Emite facturas oficiales contra ARCA/AFIP."
            providers={status.fiscal.providers}
            onProviderClick={setActiveProvider}
          />

          {/* Logística — OCA + Correo SHELVED 2026-05-25 (Andreani only).
            PedidosYa (same-city last-mile courier) lives here too — its credential
            is BYOA in BusinessChannelCredential so its status comes from the
            comunicaciones endpoint, but it renders alongside the other couriers. */}
          <AgentCard
            kind="logistica"
            title="Tus envíos."
            subtitle="Cotiza y crea envíos con tus couriers de paquetería y delivery."
            providers={[
              ...status.logistica.providers.filter(
                (p) => !["oca", "correo"].includes(p.id),
              ),
              pedidosYaProvider(comunicacionesData),
            ]}
            onProviderClick={setActiveProvider}
          />

          {/* Comunicaciones — communication channels (BYOA): WhatsApp Business,
            Twilio SMS, Resend email. WhatsApp folds in here because it is a
            messaging channel, not a standalone capability. WhatsApp status comes
            from /api/services-status; SMS/email from the comunicaciones endpoint.
            Modal maps each provider id to its own connect form. */}
          <AgentCard
            kind="comunicaciones"
            title="Tus canales."
            subtitle="Hablá con tus clientes por WhatsApp, SMS y email con tus propias cuentas."
            providers={comunicacionesToProviders(
              status.whatsapp_business?.providers ?? [],
              comunicacionesData,
            )}
            onProviderClick={setActiveProvider}
          />

          {/* Companion SHELVED 2026-05-25 — restore by uncommenting:
          <AgentCard
            kind="companion"
            title="Tu mano derecha para los empleados."
            subtitle={companionSubtitle(status.companion.employeeCount)}
            statusLabel="Activo"
          />
          */}

          {/* Supervisor */}
          <AgentCard
            kind="supervisor"
            title="Tu gerente."
            subtitle="Orquesta a Companion, Fiscal, Ventas y Logística para vos."
            statusLabel="Activo"
            contextMessage={supervisorMsg}
          />
        </div>
      )}

      <ConnectServiceModal provider={activeProvider} onClose={handleModalClose} />
    </div>
  );
}
