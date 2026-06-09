import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { InvoiceRepositoryPort, InvoiceListRecord, InvoiceDetailRecord, InvoiceCaePersistArgs } from "@/domain/ports/invoice.repository.port";
import type { Tx } from "@/domain/ports/tx";
import { InvoiceNotFoundError } from "@/domain/errors";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";

export const prismaInvoiceRepository: InvoiceRepositoryPort = {
  async list(businessId: string): Promise<InvoiceListRecord[]> {
    const rows = await prisma.invoice.findMany({
      where: { businessId },
      select: { id: true, invoiceNumber: true, documentType: true, status: true, issuedAt: true, currency: true, totalAmount: true, customerId: true, saleId: true },
      orderBy: { issuedAt: "desc" },
      take: 100,
    });
    return rows.map((inv) => ({ ...inv, totalAmount: Number(inv.totalAmount) }));
  },

  async findDetail(businessId: string, invoiceId: string): Promise<InvoiceDetailRecord | null> {
    const row = await prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
      select: { id: true, invoiceNumber: true, documentType: true, status: true, issuedAt: true, currency: true, totalAmount: true, customerId: true, saleId: true, payloadJson: true },
    });
    if (!row) return null;
    return { ...row, totalAmount: Number(row.totalAmount) };
  },

  async findForStatusUpdate(businessId: string, invoiceId: string) {
    const row = await prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
      select: { id: true, status: true, businessId: true },
    });
    if (!row) return null;
    return { id: row.id, status: row.status, businessId: row.businessId };
  },

  async updateStatusInTransaction(tx: Tx, args: { invoiceId: string; businessId: string; status: string }) {
    const prismaTx = toPrismaTx(tx);
    // Defense-in-depth tenant guard: updateMany scoped by id+businessId prevents
    // cross-tenant write if a stale invoiceId leaks through the pre-transaction read.
    const { count } = await prismaTx.invoice.updateMany({
      where: { id: args.invoiceId, businessId: args.businessId },
      data: { status: args.status },
    });
    if (count === 0) throw new InvoiceNotFoundError();
    const updated = await prismaTx.invoice.findFirst({
      where: { id: args.invoiceId, businessId: args.businessId },
      select: { id: true, status: true, invoiceNumber: true },
    });
    if (!updated) throw new InvoiceNotFoundError();
    return updated;
  },

  async persistCaeFields(args: InvoiceCaePersistArgs): Promise<{ persisted: boolean }> {
    // Defense-in-depth tenant guard: updateMany scoped by id+businessId prevents
    // a cross-tenant write if a stale invoiceId leaks. Fail-soft: WSFE already
    // succeeded, so a DB failure must not throw and unwind the legal emission.
    // null fields are skipped. A zero-row match (wrong/stale id or businessId
    // mismatch) is a persistence FAILURE — never report it as success, or the
    // invoice keeps no CAE while AFIP considers it emitted. Mirrors the prior
    // inline observability (emit-invoice-tool.cae-persist.ts logged on failure).
    try {
      const { count } = await prisma.invoice.updateMany({
        where: { id: args.invoiceId, businessId: args.businessId },
        data: {
          caeCode: args.caeCode,
          caeFchVto: args.caeFchVto ?? undefined,
          fiscalTipo: args.fiscalTipo ?? undefined,
          fiscalPtoVta: args.fiscalPtoVta ?? undefined,
          fiscalNumero: args.fiscalNumero,
          fiscalEmittedAt: args.fiscalEmittedAt,
          fiscalQrUrl: args.fiscalQrUrl ?? undefined,
        },
      });
      if (count === 0) {
        // ERROR (not WARNING): on the fiscal path this means WSFE emitted the CAE but
        // it was NOT stored (stale/wrong invoiceId). That is a legal-compliance gap —
        // it must alarm at the same severity the prior inline `update` did (it threw
        // P2025 → ERROR). (JD finding, money/fiscal path.)
        cloudLog({
          severity: "ERROR",
          component: "Fiscal",
          action: "INVOICE_CAE_PERSIST_NO_MATCH",
          a2a_transfer: false,
          message: "persistCaeFields matched 0 rows — CAE not written (id/businessId mismatch)",
          data: { invoiceId: args.invoiceId, businessId: args.businessId, cae: args.caeCode },
        });
        return { persisted: false };
      }
      return { persisted: true };
    } catch (dbErr) {
      cloudLog({
        severity: "ERROR",
        component: "Fiscal",
        action: "INVOICE_CAE_PERSIST_FAILED",
        a2a_transfer: false,
        message: "persistCaeFields DB write failed — WSFE succeeded but CAE not stored",
        data: {
          invoiceId: args.invoiceId,
          businessId: args.businessId,
          cae: args.caeCode,
          errorMessage: dbErr instanceof Error ? dbErr.message : String(dbErr),
        },
      });
      return { persisted: false };
    }
  },
};
