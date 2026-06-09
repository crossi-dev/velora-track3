// ADK Gemini config para Velora — single source of truth para los modelos
// que usa el employee + supervisor agent vía ADK. Misma configuración que
// nuestro `gemini-client.ts` pero expuesta a través del wrapper ADK.
//
// Por qué archivo separado: el ADK `Gemini` de `@google/adk` es un wrapper
// distinto a la API de `@google/genai`. Cada wrapper inicializa su propio
// cliente; comparten la misma cuenta de servicio + project.
//
// S2 (engine-agnostic seam): singletons use GeminiAdapter (which extends
// VeloraEngineAdapter extends BaseLlm) instead of raw Gemini.  Return types
// are widened to BaseLlm so callers are not coupled to a concrete engine.
//
// S3 (engine factory): direct GeminiAdapter construction replaced by
// createEngineModel() so the ENGINE env var can select the provider.
// With ENGINE unset (default "gemini") behaviour is IDENTICAL to S2.

import type { BaseLlm } from "@google/adk";
import { createEngineModel } from "./engine-factory";
import { GeminiModels } from "@/lib/gemini-models";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
// Region split mirrors gemini-client.ts (verified empirically 2026-05-10):
// Flash GA in southamerica-east1 (same region as Cloud Run); Pro must go to
// us-south1 (404 in SP). Legacy GOOGLE_CLOUD_LOCATION still honored as a
// global override for both, but the per-role envs win when set.
const COMPANION_LOCATION =
  process.env.VERTEX_LOCATION_COMPANION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "southamerica-east1";
const SUPERVISOR_LOCATION =
  process.env.VERTEX_LOCATION_SUPERVISOR ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-south1";
// Model names are read fresh from env on each call so that a Cloud Run env-var
// update takes effect without a redeploy. Singletons are invalidated when the
// resolved model name differs from the one used at creation time.
// The ADK Gemini wrapper is cheap to recreate (no persistent connection held).
function resolveEmployeeModel(): string {
  return process.env.GEMINI_MODEL ?? GeminiModels.COMPANION;
}
function resolveSupervisorModel(): string {
  return process.env.GEMINI_SUPERVISOR_MODEL ?? GeminiModels.SUPERVISOR;
}
function resolveSubAgentModel(): string {
  return process.env.GEMINI_SUB_AGENT_MODEL ?? GeminiModels.SUB_AGENT;
}
// Customer Agent (inbound B2C WhatsApp) runs its OWN model, NOT the shared
// GEMINI_SUB_AGENT_MODEL (pinned to Pro in prod for Payments tool reliability).
// A checkout turn makes ~8 LLM round-trips + nested A2A agent calls; on Pro
// (3-8s/call) that blows the 60s budget and falls back to "no pude procesar".
// Default to the proven Companion Flash config (fast, GA in southamerica-east1,
// already calls tools reliably for the employee agent). Override with
// GEMINI_CUSTOMER_MODEL to force Pro if Flash ever misbehaves on tool calling.
function resolveCustomerModel(): string {
  return process.env.GEMINI_CUSTOMER_MODEL ?? resolveEmployeeModel();
}
function resolveSubAgentLocation(model: string): string {
  return /pro/i.test(model) ? SUPERVISOR_LOCATION : COMPANION_LOCATION;
}

let _employeeGemini: BaseLlm | null = null;
let _employeeGeminiModelName: string | null = null;
let _supervisorGemini: BaseLlm | null = null;
let _supervisorGeminiModelName: string | null = null;

/** Lazy singleton — Employee Agent (GeminiAdapter / Gemini Flash via Vertex AI). */
export function getAdkEmployeeModel(): BaseLlm {
  const model = resolveEmployeeModel();
  if (!_employeeGemini || _employeeGeminiModelName !== model) {
    _employeeGemini = createEngineModel({ model, project: PROJECT_ID, location: COMPANION_LOCATION });
    _employeeGeminiModelName = model;
  }
  return _employeeGemini;
}

/** Lazy singleton — Supervisor Agent (GeminiAdapter / Gemini Pro via Vertex AI). */
export function getAdkSupervisorModel(): BaseLlm {
  const model = resolveSupervisorModel();
  if (!_supervisorGemini || _supervisorGeminiModelName !== model) {
    _supervisorGemini = createEngineModel({ model, project: PROJECT_ID, location: SUPERVISOR_LOCATION });
    _supervisorGeminiModelName = model;
  }
  return _supervisorGemini;
}

let _fiscalGemini: BaseLlm | null = null;
let _fiscalGeminiModelName: string | null = null;
let _paymentsGemini: BaseLlm | null = null;
let _paymentsGeminiModelName: string | null = null;
let _logisticaGemini: BaseLlm | null = null;
let _logisticaGeminiModelName: string | null = null;
let _ventasGemini: BaseLlm | null = null;
let _ventasGeminiModelName: string | null = null;
let _equipoGemini: BaseLlm | null = null;
let _equipoGeminiModelName: string | null = null;
let _communicationsGemini: BaseLlm | null = null;
let _communicationsGeminiModelName: string | null = null;

/** Lazy singleton — Fiscal Agent. Uses SUB_AGENT_MODEL for deterministic tool calling. */
export function getAdkFiscalModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_fiscalGemini || _fiscalGeminiModelName !== model) {
    _fiscalGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _fiscalGeminiModelName = model;
  }
  return _fiscalGemini;
}

/** Lazy singleton — Payments Agent. Respects GEMINI_SUB_AGENT_MODEL override. */
export function getAdkPaymentsModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_paymentsGemini || _paymentsGeminiModelName !== model) {
    _paymentsGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _paymentsGeminiModelName = model;
  }
  return _paymentsGemini;
}

/** Lazy singleton — Logística Agent. Uses SUB_AGENT_MODEL for deterministic tool calling. */
export function getAdkLogisticaModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_logisticaGemini || _logisticaGeminiModelName !== model) {
    _logisticaGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _logisticaGeminiModelName = model;
  }
  return _logisticaGemini;
}

/** Lazy singleton — Ventas Agent. Uses SUB_AGENT_MODEL for deterministic tool calling. */
export function getAdkVentasModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_ventasGemini || _ventasGeminiModelName !== model) {
    _ventasGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _ventasGeminiModelName = model;
  }
  return _ventasGemini;
}

/** Lazy singleton — Equipo Agent. Uses SUB_AGENT_MODEL for deterministic tool calling. */
export function getAdkEquipoModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_equipoGemini || _equipoGeminiModelName !== model) {
    _equipoGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _equipoGeminiModelName = model;
  }
  return _equipoGemini;
}

/** Lazy singleton — Communications Agent. Uses SUB_AGENT_MODEL for deterministic tool calling. */
export function getAdkCommunicationsModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_communicationsGemini || _communicationsGeminiModelName !== model) {
    _communicationsGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _communicationsGeminiModelName = model;
  }
  return _communicationsGemini;
}

let _customerGemini: BaseLlm | null = null;
let _customerGeminiModelName: string | null = null;

/** Lazy singleton — Customer Agent. Flash (own model, NOT shared Pro) for fast B2C checkout. */
export function getAdkCustomerModel(): BaseLlm {
  const model = resolveCustomerModel();
  if (!_customerGemini || _customerGeminiModelName !== model) {
    _customerGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _customerGeminiModelName = model;
  }
  return _customerGemini;
}

let _cajaGemini: BaseLlm | null = null;
let _cajaGeminiModelName: string | null = null;

/** Lazy singleton — Caja Agent. Uses SUB_AGENT_MODEL for deterministic cash tool calling. */
export function getAdkCajaModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_cajaGemini || _cajaGeminiModelName !== model) {
    _cajaGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _cajaGeminiModelName = model;
  }
  return _cajaGemini;
}

let _inventarioGemini: BaseLlm | null = null;
let _inventarioGeminiModelName: string | null = null;

/** Lazy singleton — Inventario Agent. Uses SUB_AGENT_MODEL for deterministic tool calling. */
export function getAdkInventarioModel(): BaseLlm {
  const model = resolveSubAgentModel();
  if (!_inventarioGemini || _inventarioGeminiModelName !== model) {
    _inventarioGemini = createEngineModel({ model, project: PROJECT_ID, location: resolveSubAgentLocation(model) });
    _inventarioGeminiModelName = model;
  }
  return _inventarioGemini;
}
