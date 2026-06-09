import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  createCustomerInTransaction,
  normalizeCustomerName,
  updateCustomerInTransaction,
} from "@/infrastructure/shared/customer-mutations";
import { cellStr, colIndex, normalizeNullableInput } from "./import-parsing";
import type { ImportCounters } from "./import-products";

type TxClient = Prisma.TransactionClient;

export type ImportCustomersResult =
  | { ok: true; counters: ImportCounters }
  | { ok: false; response: NextResponse };

/**
 * Imports customer rows inside an already-open transaction.
 * Route-specific row mapping only; canonical customer ownership lives in
 * customer-mutations.
 */
export async function importCustomerRows(
  tx: TxClient,
  params: { businessId: string; headers: string[]; dataRows: unknown[][] }
): Promise<ImportCustomersResult> {
  const { businessId, headers, dataRows } = params;

  const iName = colIndex(headers, "nombre", "name", "cliente", "customer", "razon social", "razón social");
  const iPhone = colIndex(headers, "telefono", "teléfono", "phone", "cel", "celular", "whatsapp", "movil", "móvil");
  const iEmail = colIndex(headers, "email", "mail", "correo", "e-mail");
  const iTaxId = colIndex(headers, "cuit", "cuil", "taxid", "tax_id", "rut", "dni", "documento");

  if (iName === -1) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No se encontró la columna 'nombre'." }, { status: 400 }),
    };
  }

  const counters: ImportCounters = { imported: 0, skipped: 0 };

  // Pre-load all customers for this business to avoid N+1 findFirst calls.
  const allExistingCustomers = await tx.customer.findMany({
    where: { businessId },
    select: { id: true, name: true },
  });
  const customersByName = new Map(
    allExistingCustomers.map((c) => [c.name.toLowerCase(), c])
  );

  for (const row of dataRows) {
    const name = normalizeCustomerName(cellStr(row as unknown[], iName));
    if (!name) {
      counters.skipped++;
      continue;
    }
    const phone = normalizeNullableInput(cellStr(row as unknown[], iPhone));
    const email = normalizeNullableInput(cellStr(row as unknown[], iEmail));
    const taxId = normalizeNullableInput(cellStr(row as unknown[], iTaxId));

    const existing = customersByName.get(name.toLowerCase()) ?? null;

    if (existing) {
      await updateCustomerInTransaction(tx, {
        businessId,
        customerId: existing.id,
        name,
        phone,
        email,
        taxId,
      });
    } else {
      await createCustomerInTransaction(tx, {
        businessId,
        name,
        phone,
        email,
        taxId,
      });
    }
    counters.imported++;
  }

  return { ok: true, counters };
}
