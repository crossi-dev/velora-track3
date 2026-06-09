export interface InvoicePdfPayload {
  /**
   * Document type hint — controls which header layout the PDF renderer uses.
   *
   * "invoice" — renders the FACTURA header with letter box (A/B/C), AFIP code,
   *   and the fiscal compliance block (CAE + QR) when caeCode is present.
   *   Use only when the document has been authorised by ARCA/AFIP (WSFE call
   *   succeeded and caeCode is populated). Mandatory fiscal document per AFIP
   *   RG 2485 / RG 4291.
   *
   * "receipt" (default) — renders "COMPROBANTE / sin validez fiscal". No letter
   *   box, no AFIP code, no CAE block even if caeCode happens to be present.
   *   Use for payment confirmation receipts sent to the customer when the fiscal
   *   Factura is handled separately (e.g. via Fiscal Agent A2A for standalone
   *   PaymentIntents). Per AFIP 2026 + Stripe canonical pattern: a post-payment
   *   receipt is informational; the Factura C (emitted via WSFE by the Fiscal
   *   Agent) is the legally-binding fiscal document.
   *
   * References:
   *   AFIP RG 2485 — CAE + Vto. CAE mandatory on the Factura, not on plain receipts.
   *   AFIP RG 4291/2018 — QR mandatory on electronic invoices (Facturas), not receipts.
   *   Stripe 2026 receipts vs invoices: https://stripe.com/resources/more/is-an-invoice-a-receipt
   *   Wetrex AR 2026 — merchant must emit AFIP Factura independently of MP receipt:
   *     https://www.wetrex.agency/elearning/contable/facturar-con-mercado-pago/
   */
  documentType?: "invoice" | "receipt";
  business: {
    name: string;
    cuit: string | null;
    address: string | null;
    currency: string;
    ivaCondition?: string | null;
    puntoVenta?: string | null;
    iibb?: string | null;
    activityStart?: string | null;
    taxRate?: number | null;
  };
  customer: {
    name: string;
    firstName?: string | null;
    lastName?: string | null;
    taxId: string | null;
    email: string | null;
    phone: string | null;
    /** AFIP tax condition of the buyer — used for letter derivation when fiscalTipo is absent. */
    taxCondition?: string | null;
  };
  sale: {
    id: string;
    invoiceNumber: string;
    date: string;
    items: Array<{
      productName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    total: number;
    /**
     * Optional shipping line appended after product items in the PDF table.
     * Populated by trigger-fiscal-receipt post-confirm when PaymentIntent includes
     * a shipping cost (sale linked to an MP preference with shippingRequired=true).
     */
    shippingLine?: {
      courier: string;
      costARS: number;
    } | null;
  };
  /**
   * WSFE tipoComprobante code persisted after AFIP CAE emission (RG 2485).
   * Canonical map: 1=A, 6=B, 11=C, 19=E.
   * When present this is the authoritative source for the invoice letter printed on the PDF.
   * When absent (pre-CAE receipts, sandbox, or legacy rows) the letter falls back to
   * seller ivaCondition + buyer taxCondition heuristic.
   */
  fiscalTipo?: number | null;
  /**
   * CAE (Código de Autorización Electrónica) — 14-digit code returned by WSFE.
   * Mandatory on the printed comprobante per AFIP RG 2485.
   * Absent for sandbox / non-fiscal receipts — PDF skips the CAE block when null.
   */
  caeCode?: string | null;
  /**
   * CAE expiry date — ISO-8601 UTC string (midnight UTC, AFIP YYYYMMDD).
   * Printed alongside caeCode per RG 2485 as "Vto. CAE: dd/MM/yyyy".
   */
  caeFchVto?: string | null;
  /**
   * AFIP RG 4291/2018 QR URL — https://www.afip.gob.ar/fe/qr/?p=<base64json>.
   * Rendered as an ~80×80 pt QR image on the PDF when present.
   * Absent for sandbox / non-fiscal receipts — PDF skips QR rendering when null.
   */
  fiscalQrUrl?: string | null;
}

export interface InvoiceLayout {
  ML: number;
  MR: number;
  PW: number;
  CW: number;
  BLACK: string;
  GRAY: string;
  LIGHTGRAY: string;
  BORDER: string;
  WHITE: string;
  FOOTER_Y: number;
  PAGE_BOTTOM: number;
}

export interface InvoiceHeaderContext {
  isInvoice: boolean;
  invoiceLetter: string;
  ivaCondition: string;
  ptoVenta: string;
  nroComp: string;
  dateLabel: string;
  statusLabel: string;
}
