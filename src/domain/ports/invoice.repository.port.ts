import type { Tx } from "./tx";

export interface InvoiceForStatusUpdate {
  id: string;
  status: string;
  businessId: string;
}

export interface InvoiceStatusRecord {
  id: string;
  status: string;
  invoiceNumber: string;
}

export interface InvoiceListRecord {
  id: string;
  invoiceNumber: string;
  documentType: string | null;
  status: string;
  issuedAt: Date;
  currency: string;
  totalAmount: number;
  customerId: string | null;
  saleId: string | null;
}

export interface InvoiceDetailRecord {
  id: string;
  invoiceNumber: string;
  documentType: string | null;
  status: string;
  issuedAt: Date;
  currency: string;
  totalAmount: number;
  customerId: string | null;
  saleId: string | null;
  payloadJson: string;
}

export interface InvoiceCaePersistArgs {
  businessId: string;
  invoiceId: string;
  caeCode: string;
  caeFchVto: Date | null;
  fiscalTipo: number | null;
  fiscalPtoVta: number | null;
  fiscalNumero: number;
  fiscalEmittedAt: Date;
  fiscalQrUrl: string | null;
}

export interface InvoiceRepositoryPort {
  list(businessId: string): Promise<InvoiceListRecord[]>;
  findDetail(businessId: string, invoiceId: string): Promise<InvoiceDetailRecord | null>;
  findForStatusUpdate(businessId: string, invoiceId: string): Promise<InvoiceForStatusUpdate | null>;
  updateStatusInTransaction(tx: Tx, args: { invoiceId: string; businessId: string; status: string }): Promise<InvoiceStatusRecord>;
  /**
   * Fail-soft write-back of AFIP CAE fields after a successful WSFE call.
   * Scoped by id + businessId (defense-in-depth tenant isolation — the prior
   * inline write scoped by id alone). Never throws: returns { persisted: false }
   * if the DB write fails, mirroring the prior fail-soft behavior. null fields
   * are skipped (left unchanged).
   */
  persistCaeFields(args: InvoiceCaePersistArgs): Promise<{ persisted: boolean }>;
}
