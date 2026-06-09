// ARCA (ex-AFIP) domain types for WSAA + WSFE integration.
//
// WSAA  — Web Service de Autenticación y Autorización
//          Returns a Ticket de Acceso (TA) valid for 12 hours.
// WSFE  — Web Service de Facturación Electrónica v1 (FECAESolicitar).
//          Accepts the TA and issues a CAE (Código de Autorización Electrónica).

// ── WSAA ─────────────────────────────────────────────────────────────────────

export interface ArcaTicket {
  /** Raw access token — opaque string returned by WSAA. */
  token: string;
  /** Cryptographic sign — opaque string returned by WSAA. */
  sign: string;
  /** Expiry as ISO-8601 UTC string (parsed from WSAA XML). */
  expiresAt: string;
}

// ── WSFE — input ─────────────────────────────────────────────────────────────

/** AFIP IVA condition codes (condicion_iva). */
export type CondicionIva =
  | "RI"   // Responsable Inscripto
  | "MT"   // Monotributista
  | "EX"   // Exento
  | "CF";  // Consumidor Final

/** Invoice type codes used by WSFE FECAESolicitar. */
export type TipoComprobante =
  | 1   // Factura A
  | 2   // Nota Débito A
  | 3   // Nota Crédito A
  | 6   // Factura B
  | 7   // Nota Débito B
  | 8   // Nota Crédito B
  | 11  // Factura C (Monotributo)
  | 12  // Nota Débito C
  | 13; // Nota Crédito C

/**
 * Associated voucher block required by AFIP on every NC/ND emission.
 * WSFE rejects FECAESolicitar for types 2/3/7/8/12/13 without this block.
 */
export interface CbteAsoc {
  /** WSFE comprobante type of the original invoice (e.g. 1=Factura A, 6=Factura B, 11=Factura C). */
  tipo: TipoComprobante;
  /** Punto de venta of the original invoice (1–9999). */
  ptoVta: number;
  /** Sequential number of the original invoice. */
  nro: number;
}

/** AFIP IVA rate codes (alicuota_id). */
export type AlicuotaId =
  | 3   // 0% (exento)
  | 4   // 10.5%
  | 5   // 21%
  | 6   // 27%
  | 8   // 5%
  | 9;  // 2.5%

export interface InvoiceIvaItem {
  id: AlicuotaId;
  /** Neto gravado en ARS. */
  baseImponible: number;
  /** IVA calculado en ARS. */
  importe: number;
}

export interface EmitInvoiceInput {
  /** Business CUIT (11 digits, no hyphens). */
  cuit: string;
  /** Punto de venta (1–9999). */
  puntoVenta: number;
  /** WSFE comprobante type: 1=A, 6=B, 11=C. */
  tipoComprobante: TipoComprobante;
  /** Customer CUIT (11 digits) — required for type A; optional for B/C. */
  customerCuit: string | null;
  /** Total amount including taxes, in ARS. */
  importeTotal: number;
  /** Net amount not subject to IVA, in ARS (0 for Monotributo). */
  importeNoGravado: number;
  /** Net taxable amount, in ARS (0 for Monotributo). */
  importeNeto: number;
  /** IVA exempted amount, in ARS. */
  importeExento: number;
  /** IVA breakdown (empty for Monotributo type C). */
  ivaItems: InvoiceIvaItem[];
  /** Concept: 1=Productos, 2=Servicios, 3=Productos y Servicios. */
  concepto: 1 | 2 | 3;
  /**
   * Associated voucher — REQUIRED by AFIP for NC/ND types (2,3,7,8,12,13).
   * Must reference the original invoice being credited or debited.
   */
  cbteAsoc?: CbteAsoc;
}

// ── WSFE — output ─────────────────────────────────────────────────────────────

export interface EmitInvoiceResult {
  sandbox: false;
  cae: string;
  /** YYYYMMDD — AFIP CAE expiry date. */
  vencimientoCae: string;
  /** Sequential invoice number assigned by AFIP. */
  numero: number;
  tipoComprobante: TipoComprobante;
  puntoVenta: number;
  /** UTC ISO-8601 emission timestamp. */
  issuedAt: string;
}

// ── Credential (loaded from DB + GCS) ────────────────────────────────────────

export interface ArcaCredential {
  businessId: string;
  /** CUIT of the contribuyente as 11 digits (no hyphens). */
  cuit: string;
  /** Punto de venta number registered in AFIP (1–9999). */
  puntoVenta: number;
  /** IVA condition driving invoice type selection. */
  condicionIva: CondicionIva;
  /** GCS object path — e.g. `velora-arca-certs/{businessId}.p12`. */
  certGcsPath: string;
  /** Passphrase for the PKCS#12 cert — decrypted at runtime from DB ciphertext. */
  passphrase: string;
}
