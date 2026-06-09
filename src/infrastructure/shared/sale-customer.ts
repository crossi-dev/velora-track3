import {
  createCustomerInTransaction,
  normalizeCustomerName,
} from "@/infrastructure/shared/customer-mutations";
import { CustomerNotFoundError } from "@/domain/errors";

/**
 * Fallback explícito cuando una venta llega sin customerId.
 *
 * Política de producto: el comerciante puede registrar ventas sin
 * cliente identificado (compra al paso, persona que entra y sale). En
 * ese caso, la venta se asigna a un cliente "Consumidor Final" del
 * business — la fila se crea on-demand la primera vez. La factura/
 * comprobante queda asociado a ese cliente, NO huérfano.
 *
 * El nombre se exporta como constante para que cualquier comparación
 * server-side (analytics, exports, undo) use el mismo string canónico.
 */
export const CONSUMIDOR_FINAL_NAME = "Consumidor Final";

export async function resolveSaleCustomerInTransaction(
  tx: Parameters<typeof createCustomerInTransaction>[0],
  args: {
    businessId: string;
    customerId?: string | null;
    fallbackCustomerName: string;
    normalizedFallbackCustomerName: string;
  }
) {
  if (args.customerId) {
    const customer = await tx.customer.findFirst({
      where: { id: args.customerId, businessId: args.businessId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        taxId: true,
        dni: true,
        address: true,
        postalCode: true,
      },
    });

    if (customer) {
      return customer;
    }
    // Explicit customerId was provided but not found — don't silently assign to fallback
    throw new CustomerNotFoundError();
  }

  const fallbackCustomer = await tx.customer.findFirst({
    where: {
      businessId: args.businessId,
      name: args.normalizedFallbackCustomerName,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      taxId: true,
    },
  });

  if (fallbackCustomer) {
    return fallbackCustomer;
  }

  return createCustomerInTransaction(tx, {
    businessId: args.businessId,
    name: args.fallbackCustomerName,
  });
}

export { normalizeCustomerName };
