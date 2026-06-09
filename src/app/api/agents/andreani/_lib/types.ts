// Andreani Agent — shared TypeScript types.
// Used by the API client, skill modules, and the JSON-RPC dispatcher.

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AndreaniAuthContext {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// ── Skill inputs ──────────────────────────────────────────────────────────────

export interface QuoteInput {
  originPostalCode: string;
  destinationPostalCode: string;
  weightGrams: number;
  declaredValue: number;
}

export interface CustomerAddress {
  name: string;
  address: string;
  postalCode: string;
  phone: string;
  city?: string;
  /** DNI del destinatario. Requerido por Andreani producción. Null → shipment-create lanza error claro. */
  dni?: string | null;
}

export interface CreateShipmentInput {
  saleId: string;
  customer: CustomerAddress;
  service: "sucursal" | "domicilio" | "express";
  weightGrams: number;
  /** Declared value in ARS for the shipment (used by Andreani valorDeclarado). Optional — defaults to 0. */
  declaredValue?: number;
}

export interface TrackInput {
  trackingNumber: string;
}

// ── Skill outputs ─────────────────────────────────────────────────────────────

export interface QuoteOption {
  service: "sucursal" | "domicilio" | "express";
  serviceLabel: string;
  priceARS: number;
  estimatedDays: number;
}

export interface QuoteResult {
  options: QuoteOption[];
  originPostalCode: string;
  destinationPostalCode: string;
}

export interface CreateShipmentResult {
  trackingNumber: string;
  labelPdfUrl: string | null;
  estimatedDelivery: string; // ISO date string
  service: string;
}

export interface TrackingEvent {
  timestamp: string; // ISO
  status: string;
  description: string;
  location?: string;
}

export interface TrackResult {
  trackingNumber: string;
  currentStatus: string;
  events: TrackingEvent[];
}

// ── Andreani REST API shapes (sandbox) ───────────────────────────────────────

export interface AndreaniLoginResponse {
  access_token: string;
  expires_in: number; // seconds
  token_type: string;
}

export interface AndreaniTarifaResponse {
  tarifas?: AndreaniTarifa[];
}

export interface AndreaniTarifa {
  contrato: string;
  descripcion: string;
  precio: number;
  plazoEntrega: number; // días hábiles
}

export interface AndreaniOrdenResponse {
  nroAndreani: string;
  estado: string;
  fechaEstimadaEntrega?: string;
}

export interface AndreaniEventoResponse {
  estado: string;
  fecha: string;
  sucursal?: string;
  descripcion?: string;
}

export interface AndreaniTrackingResponse {
  envio?: {
    estado: string;
    eventos?: AndreaniEventoResponse[];
  };
}
