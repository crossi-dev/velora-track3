import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  createSupplierInTransaction,
  normalizeSupplierName,
  updateSupplierInTransaction,
} from "@/app/api/_lib/supplier-mutations";
import { cellStr, colIndex, normalizeNullableInput } from "./import-parsing";
import type { ImportCounters } from "./import-products";

type TxClient = Prisma.TransactionClient;

export type ImportSuppliersResult =
  | { ok: true; counters: ImportCounters }
  | { ok: false; response: NextResponse };

/**
 * Imports supplier rows inside an already-open transaction.
 * Supplier writes are intentional here; canonical supplier ownership lives
 * in supplier-mutations.
 */
export async function importSupplierRows(
  tx: TxClient,
  params: { businessId: string; headers: string[]; dataRows: unknown[][] }
): Promise<ImportSuppliersResult> {
  const { businessId, headers, dataRows } = params;

  const iName = colIndex(headers, "nombre", "name", "proveedor", "supplier", "empresa", "company", "razon social", "razón social");
  const iPhone = colIndex(headers, "telefono", "teléfono", "phone", "cel", "celular", "whatsapp");
  const iEmail = colIndex(headers, "email", "mail", "correo", "e-mail");
  const iContact = colIndex(headers, "contacto", "contact", "contactname", "contact_name", "nombre_contacto", "representante");

  if (iName === -1) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No se encontró la columna 'nombre'." }, { status: 400 }),
    };
  }

  const counters: ImportCounters = { imported: 0, skipped: 0 };

  // Pre-load all suppliers for this business to avoid N+1 findFirst calls.
  const allExistingSuppliers = await tx.supplier.findMany({
    where: { businessId },
    select: { id: true, name: true },
  });
  const suppliersByName = new Map(
    allExistingSuppliers.map((s) => [s.name.toLowerCase(), s])
  );

  for (const row of dataRows) {
    const name = normalizeSupplierName(cellStr(row as unknown[], iName));
    if (!name) {
      counters.skipped++;
      continue;
    }
    const phone = normalizeNullableInput(cellStr(row as unknown[], iPhone));
    const email = normalizeNullableInput(cellStr(row as unknown[], iEmail));
    const contactName = normalizeNullableInput(cellStr(row as unknown[], iContact));

    const existing = suppliersByName.get(name.toLowerCase()) ?? null;

    if (existing) {
      await updateSupplierInTransaction(tx, {
        businessId,
        supplierId: existing.id,
        name,
        phone,
        email,
        contactName,
      });
    } else {
      await createSupplierInTransaction(tx, {
        businessId,
        name,
        phone,
        email,
        contactName,
      });
    }
    counters.imported++;
  }

  return { ok: true, counters };
}
