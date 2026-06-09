// Correo Argentino Agent — shared TypeScript types.
// API surface: MiCorreo REST API v1
//   PROD: https://api.correoargentino.com.ar/micorreo/v1
//
// Auth: POST /Token → Bearer token (OAuth2 client-credentials-style).
// Rates: POST /Rates → shipping quote options per delivery type.
// Agencies: GET /Agencies → list of Correo branches by province.
//
// Integration note (2026-05-19): The MiCorreo API docs are not publicly
// accessible without a registered account. Endpoint shapes below are derived
// from the official API brief provided during integration planning. If Correo
// updates field names, align this file with the current API spec first.

// ── Credentials ───────────────────────────────────────────────────────────────

/**
 * Credentials stored in CourierCredential for provider="correo".
 * Correo Argentino's MiCorreo API uses username+password for token auth,
 * plus the customerId obtained from POST /Users/validate.
 */
export interface CorreoCredentials {
  /** MiCorreo registered username (typically the business email). */
  username: string;
  /** MiCorreo password. NEVER log or return. */
  password: string;
  /**
   * customerId returned by POST /Users/validate after first login.
   * Required for POST /Rates. Stored at credential-connect time so
   * we do not call Users/validate on every quote.
   */
  customerId: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * In-memory token context after a successful POST /Token call.
 * TTL is controlled by expires_in from the response.
 */
export interface CorreoAuthContext {
  accessToken: string;
  /** Epoch ms when this token expires (conservatively early). */
  expiresAt: number;
}

// ── POST /Token ───────────────────────────────────────────────────────────────

export interface CorreoTokenRequest {
  username: string;
  password: string;
}

export interface CorreoTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds until expiry. */
  expires_in: number;
}

// ── POST /Users/validate ─────────────────────────────────────────────────────

export interface CorreoValidateResponse {
  customerId: string;
  /** Business name or user name — informational only. */
  name?: string;
}

// ── POST /Rates ───────────────────────────────────────────────────────────────

/**
 * Request body for POST /Rates.
 * deliveryType: "D" = domicilio, "S" = sucursal (or empty = all types).
 */
export interface CorreoRatesRequest {
  customerId: string;
  codigoPostalOrigen: string;
  codigoPostalDestino: string;
  /** "D" (domicilio) | "S" (sucursal) | omit for all types */
  deliveryType?: string;
  /** Weight in kg (e.g. 1.5) */
  peso: number;
  /** Length in cm */
  largo: number;
  /** Height in cm */
  alto: number;
  /** Width in cm */
  ancho: number;
}

/** A single option returned by POST /Rates. */
export interface CorreoRateOption {
  /** Internal Correo delivery type code ("D" | "S" | etc.) */
  deliveryType: string;
  /** Internal product type code */
  productType: string;
  /** Human-readable product name (e.g. "Encomienda Standard") */
  productName: string;
  /** Price in ARS (net, no taxes or as returned by Correo) */
  price: number;
  /** Minimum delivery days */
  minDeliveryDays: number;
  /** Maximum delivery days */
  maxDeliveryDays: number;
}

// ── GET /Agencies ─────────────────────────────────────────────────────────────

/** A Correo Argentino branch as returned by GET /Agencies. */
export interface CorreoAgency {
  agencyId?: string;
  name?: string;
  address?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  phone?: string;
  hours?: string;
}

// ── Canonical result shapes (Logística adapter contract) ─────────────────────

export interface CorreoTarifaOption {
  /** Lowercase service key for internal use. */
  service: string;
  /** Human-readable label shown to the owner. */
  serviceLabel: string;
  priceARS: number;
  /** Estimated days uses the midpoint of min/max range. */
  estimatedDays: number;
}

export interface CorreoQuoteResult {
  originPostalCode: string;
  destinationPostalCode: string;
  provider: "correo";
  options: CorreoTarifaOption[];
}

export interface CorreoCreateResult {
  saleId: string;
  trackingNumber: string;
  labelUrl: string | null;
  estimatedDelivery: string | null;
  service: string;
  provider: "correo";
}

export interface CorreoTrackResult {
  trackingNumber: string;
  provider: "correo";
  status: string;
  events: Array<{
    timestamp: string;
    description: string;
    location?: string;
  }>;
}
