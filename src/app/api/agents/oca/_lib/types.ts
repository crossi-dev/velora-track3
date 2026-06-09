// OCA Agent — shared TypeScript types.
// Used by the API client, adapter, and preflight modules.
//
// OCA exposes TWO separate API surfaces:
//   1. ApiPostal (REST/JSON) at www1.oca.com.ar/ApiPostal/
//      Auth: POST LoginController/loginSigma → 5-minute bearer token.
//      Used for: branch lookup (ObtenerSucursalOca), tracking (EstadoActual,
//      HistorialSeguimiento), piece creation (CrearPieza).
//
//   2. e-Pak tracking (SOAP/HTTP) at webservice.oca.com.ar/ePak_tracking/
//      Auth: usr/psw passed inline on every call.
//      Used for: tarifa quotes (Tarifar_Envio_Corporativo), order creation
//      (IngresoORMultiplesRetiros), labels, cancel.
//
// This integration covers:
//   - quote  → Tarifar_Envio_Corporativo (e-Pak, GET with QS params)
//   - create → IngresoORMultiplesRetiros (e-Pak, POST with XML body)
//   - track  → EstadoActual + HistorialSeguimiento (ApiPostal, POST bearer)
//   - branches → ObtenerSucursalOca (ApiPostal, GET bearer)

// ── Auth ──────────────────────────────────────────────────────────────────────

/** Bearer token from ApiPostal loginSigma. Valid ~5 minutes. */
export interface OcaAuthContext {
  accessToken: string;
  /** Epoch ms when this token expires. Refresh before hitting this. */
  expiresAt: number;
}

// ── Credential shape stored in CourierCredential ──────────────────────────────

export interface OcaCredentials {
  /** OCA e-Pak account username (same user for both APIs). */
  usuario: string;
  /** OCA e-Pak account password. NEVER log or return. */
  password: string;
  /** CUIT of the business (e.g. "20-12345678-9") — required for Tarifar_Envio_Corporativo. */
  cuit: string;
  /** OCA operativa number (commercial contract code assigned by OCA). */
  operativa: string;
  /** OCA account number (nroCuenta) used in shipment XML. */
  nroCuenta: string;
}

// ── ApiPostal REST shapes ─────────────────────────────────────────────────────

export interface OcaLoginResponse {
  success: boolean;
  message: string;
  result: string; // the bearer token string
}

export interface OcaSucursal {
  idCentroImposicion?: number;
  nombre?: string;
  domicilio?: string;
  localidad?: string;
  provincia?: string;
  codigoPostal?: string;
  telefono?: string;
  horario?: string;
}

export interface OcaEstadoActualResponse {
  success: boolean;
  message: string;
  result: {
    estado?: string;
    descripcionEstado?: string;
    fechaEstado?: string;
    sucursal?: string;
  } | null;
}

export interface OcaHistorialItem {
  estado?: string;
  descripcionEstado?: string;
  fechaEvento?: string;
  sucursal?: string;
}

export interface OcaHistorialResponse {
  success: boolean;
  message: string;
  result: OcaHistorialItem[] | null;
}

// ── e-Pak XML/HTTP shapes ─────────────────────────────────────────────────────

/** Parsed quote option from Tarifar_Envio_Corporativo XML response. */
export interface OcaTarifaOption {
  service: string;
  serviceLabel: string;
  priceARS: number;
  estimatedDays: number;
}

/** Canonical quote result shape used by the Logística adapter. */
export interface OcaQuoteResult {
  originPostalCode: string;
  destinationPostalCode: string;
  provider: "oca";
  options: OcaTarifaOption[];
}

/** Canonical create result shape. */
export interface OcaCreateResult {
  saleId: string;
  trackingNumber: string;
  labelUrl: string | null;
  estimatedDelivery: string | null;
  service: string;
  provider: "oca";
}

/** Canonical track result shape. */
export interface OcaTrackResult {
  trackingNumber: string;
  provider: "oca";
  status: string;
  events: Array<{
    timestamp: string;
    description: string;
    location?: string;
  }>;
}
