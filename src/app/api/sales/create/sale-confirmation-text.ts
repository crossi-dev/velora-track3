import { CONSUMIDOR_FINAL_NAME } from "@/infrastructure/shared/sale-customer";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";

// Pure formatter — sin dependencias de DB ni env. Aislado para tests rápidos
// y para evitar tirar al prisma client al cargar el módulo en el test runner.

type SaleItem = InvoicePayload["sale"]["items"][number];

function formatMoney(total: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(total);
  } catch {
    return `$${Math.round(total).toLocaleString("es-AR")}`;
  }
}

function isConsumidorFinal(name: string): boolean {
  return name.trim().toLowerCase() === CONSUMIDOR_FINAL_NAME.toLowerCase();
}

function buildSummaryLine(items: SaleItem[], customerName: string): string {
  const customerSuffix = isConsumidorFinal(customerName) ? "" : ` a ${customerName}`;
  const first = items[0];
  if (!first) return `venta${customerSuffix}`;
  const firstChunk = `${first.quantity}× ${first.productName}`;
  const tailCount = items.length - 1;
  const tail = tailCount === 0 ? "" : ` y ${tailCount} más`;
  return `${firstChunk}${tail}${customerSuffix}`;
}

export function buildSaleConfirmationText(args: {
  items: SaleItem[];
  customerName: string;
  total: number;
  currency: string;
}): string {
  const summary = buildSummaryLine(args.items, args.customerName);
  const formattedTotal = formatMoney(args.total, args.currency);
  return `💰 Venta: ${summary} — ${formattedTotal}`;
}
