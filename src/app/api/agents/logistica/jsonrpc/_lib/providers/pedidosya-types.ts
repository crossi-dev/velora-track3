// PedidosYa Courier API — shared TypeScript types for the Logística adapter.
//
// API source (OpenAPI spec HTTP 200 verified 2026-06-04):
//   https://developers.pedidosya.com/courier-api/v3.json
// Response shapes below mirror the spec exactly (POST /v3/shippings/estimates,
// POST /v3/shippings, GET /v3/shippings/{id}, GET /v3/shippings/{id}/tracking).

// ── Port output shapes (returned by adapter methods) ─────────────────────────

export interface PedidosYaQuoteOption {
  service: string;
  serviceLabel: string;
  priceARS: number;
  estimatedDays: number;
  estimatedMinutes?: number;
}

export interface PedidosYaQuoteResult {
  originPostalCode: string;
  destinationPostalCode: string;
  provider: "pedidosya";
  options: PedidosYaQuoteOption[];
}

export interface PedidosYaCreateResult {
  trackingNumber:   string;
  orderId:          string;
  confirmationCode?: string;
  labelUrl:         null;     // PedidosYa v3 does not return a label PDF
  /** v3 exposes a live-tracking share URL instead of a label PDF. */
  shareLocationUrl?: string | null;
  estimatedDelivery: string | null;  // ISO 8601 (route.deliveryTimeTo) or null
  service:          string;
}

export interface PedidosYaTrackResult {
  trackingNumber: string;
  provider: "pedidosya";
  status: string;
  events: Array<{ timestamp: string; description: string; location?: string }>;
}

// ── PedidosYa REST API response shapes (v3) ───────────────────────────────────
// Sourced from the OpenAPI spec: https://developers.pedidosya.com/courier-api/v3.json
// Auth: Authorization header carries the token verbatim (no token-exchange step).

interface PedidosYaDeliveryOffer {
  deliveryOfferId?:     string;
  deliveryMode?:        "EXPRESS" | "SCHEDULED";
  estimatedDrivingTime?: number; // seconds
  deliveryTimeFrom?:    string;
  deliveryTimeTo?:      string;
  pricing?:             { subtotal?: number; taxes?: number; total?: number; currency?: string };
}

/** POST /v3/shippings/estimates response. */
export interface PedidosYaEstimateResponse {
  estimateId?:     string;
  referenceId?:    string;
  deliveryOffers?: PedidosYaDeliveryOffer[];
  route?:          { distance?: number };
}

/** POST /v3/shippings and GET /v3/shippings/{shippingId} response. */
export interface PedidosYaShippingResponse {
  shippingId?:       string;
  confirmationCode?: string;
  referenceId?:      string;
  status?:           string; // REJECTED|CONFIRMED|IN_PROGRESS|NEAR_PICKUP|PICKED_UP|NEAR_DROPOFF|COMPLETED|CANCELLED
  shareLocationUrl?: string;
  route?: {
    deliveryMode?:    "EXPRESS" | "SCHEDULED";
    deliveryTimeFrom?: string;
    deliveryTimeTo?:  string;
    distance?:        number;
    pricing?:         { subtotal?: number; taxes?: number; total?: number; currency?: string };
  };
}

/** GET /v3/shippings/{shippingId}/tracking response (live courier position). */
export interface PedidosYaTrackingResponse {
  latitude?:             number;
  longitude?:            number;
  deliveryName?:         string;
  estimatedPickUpTime?:  string;
  estimatedDropOffTime?: string;
  deliveryTransport?:    string;
}
