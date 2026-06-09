// shipment.quote skill — cotiza envío Andreani.
//
// Llama a la API de tarifas con CP origen/destino + peso + valor declarado.
// Retorna un array de opciones (sucursal / domicilio / express) ordenadas por precio.
//
// The SERVICE_MAP is built at call time from the resolved contract codes so that
// when Andreani returns the real account contract codes in the tarifas response,
// they map to the correct service labels. Falls back to static placeholder keys
// when env vars are absent (mock / sandbox mode without real credentials).

import { resolveTokenWithEnv, fetchTarifas, resolveContractCodes } from "./andreani-api-client";
import type { QuoteInput, QuoteResult, QuoteOption } from "./types";

// ── Contract code → service mapping ──────────────────────────────────────────

interface ServiceEntry {
  service: "sucursal" | "domicilio" | "express";
  label: string;
}

/**
 * Build the Andreani contract → service map from resolved contract codes.
 * Per-business credentials take priority over env vars (see resolveContractCodes).
 * Fallback keys ("contrato-sucursal" etc.) are kept so sandbox demo mode works
 * when no real contract codes are configured.
 */
async function buildServiceMap(businessId: string): Promise<Record<string, ServiceEntry>> {
  const map: Record<string, ServiceEntry> = {
    // Static fallback keys used by sandbox / mock responses.
    "contrato-sucursal":  { service: "sucursal",  label: "Retiro en sucursal" },
    "contrato-domicilio": { service: "domicilio", label: "Envío a domicilio"  },
    "contrato-express":   { service: "express",   label: "Express (24 hs)"    },
  };

  // Best-effort: if contract codes are unavailable (no creds, no env vars),
  // keep the static fallbacks so quote still runs in sandbox mode.
  try {
    const codes = await resolveContractCodes(businessId);
    if (codes.sucursal)  map[codes.sucursal]  = { service: "sucursal",  label: "Retiro en sucursal" };
    if (codes.domicilio) map[codes.domicilio] = { service: "domicilio", label: "Envío a domicilio"  };
    if (codes.express)   map[codes.express]   = { service: "express",   label: "Express (24 hs)"    };
  } catch {
    // resolveContractCodes throws only when neither per-business nor env-var codes
    // are set. In that case the static fallback map is sufficient for sandbox mode.
  }

  return map;
}

// Fallback for unknown contract codes returned by the API.
function resolveService(contrato: string): ServiceEntry {
  return { service: "domicilio", label: contrato };
}

// ── Main skill ────────────────────────────────────────────────────────────────

export async function shipmentQuote(input: QuoteInput, businessId: string): Promise<QuoteResult> {
  const { ctx, environment } = await resolveTokenWithEnv(businessId);
  const raw = await fetchTarifas(
    input.originPostalCode,
    input.destinationPostalCode,
    input.weightGrams,
    input.declaredValue,
    ctx,
    businessId,
    environment,
  );

  const serviceMap = await buildServiceMap(businessId);

  const options: QuoteOption[] = (raw.tarifas ?? []).map((t) => {
    const mapped = serviceMap[t.contrato] ?? resolveService(t.contrato);
    return {
      service:       mapped.service,
      serviceLabel:  mapped.label,
      priceARS:      t.precio,
      estimatedDays: t.plazoEntrega,
    };
  });

  // Sort by price ascending.
  options.sort((a, b) => a.priceARS - b.priceARS);

  return {
    options,
    originPostalCode:      input.originPostalCode,
    destinationPostalCode: input.destinationPostalCode,
  };
}
