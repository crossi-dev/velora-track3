export interface AndreaniShipmentUpsertArgs {
  saleId: string;
  businessId: string;
  trackingNumber: string;
  service: string;
  /** Bare GCS key (e.g. "pdfs/label/{businessId}/{trackingNumber}.pdf") or null.
   *  NEVER a signed URL — signed URLs expire; consumers regenerate on demand. */
  labelPdfPath: string | null;
  estimatedDelivery: Date;
}

export interface ShipmentRepositoryPort {
  /**
   * Idempotent upsert of an Andreani shipment row.
   * WHERE: { saleId } — unique per sale.
   * CREATE: all fields including businessId and status="created".
   * UPDATE: tracking fields only; businessId is intentionally excluded
   *         to prevent cross-tenant ownership change on re-upsert.
   */
  upsertAndreaniShipment(args: AndreaniShipmentUpsertArgs): Promise<void>;
}
