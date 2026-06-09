// shipment.track skill — consulta estado de un envío Andreani.
//
// Fuentes de datos (en orden):
//   1. API Andreani sandbox GET /v2/envios/{tracking}
//   2. DB AndreaniShipment.events (fallback si la API no responde)
//
// Los eventos API se persisten en DB para que el webhook pueda extenderlos luego.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { resolveTokenWithEnv, fetchTracking } from "./andreani-api-client";
import type { TrackInput, TrackResult, TrackingEvent } from "./types";

export async function shipmentTrack(input: TrackInput, businessId: string): Promise<TrackResult> {
  // findFirst with businessId — trackingNumber alone is not unique across tenants;
  // findUnique on a non-unique compound would fail at the Prisma level.
  const dbRecord = await prisma.andreaniShipment.findFirst({
    where: { trackingNumber: input.trackingNumber, businessId },
    select: { status: true, events: true },
  });

  let apiEvents: TrackingEvent[] = [];
  let currentStatus = dbRecord?.status ?? "unknown";

  try {
    const { ctx, environment } = await resolveTokenWithEnv(businessId);
    const raw = await fetchTracking(input.trackingNumber, ctx, businessId, environment);

    if (raw.envio) {
      currentStatus = raw.envio.estado ?? currentStatus;
      apiEvents = (raw.envio.eventos ?? []).map((e) => ({
        timestamp:   e.fecha,
        status:      e.estado,
        description: e.descripcion ?? e.estado,
        location:    e.sucursal,
      }));
    }
  } catch (err) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ANDREANI_TRACK_API_FAIL",
      a2a_transfer: false, message: "Andreani tracking API unreachable, using DB events",
      data: { trackingNumber: input.trackingNumber, error: err instanceof Error ? err.message : String(err) } });
  }

  // Persist refreshed events back to DB if we got API data.
  if (apiEvents.length > 0 && dbRecord !== null) {
    await prisma.andreaniShipment.updateMany({
      where: { trackingNumber: input.trackingNumber, businessId },
      data: { events: apiEvents as unknown as Prisma.InputJsonValue, status: currentStatus },
    });
  }

  // Merge: prefer API events, fall back to DB events.
  const events: TrackingEvent[] =
    apiEvents.length > 0
      ? apiEvents
      : Array.isArray(dbRecord?.events)
        ? (dbRecord.events as unknown as TrackingEvent[])
        : [];

  return {
    trackingNumber: input.trackingNumber,
    currentStatus,
    events,
  };
}
