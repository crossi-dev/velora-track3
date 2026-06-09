// src/lib/mcp/_lib/velora-customer.adapter.ts — Velora concrete implementation of CustomerBackend.
//
// Wraps the existing query/upsert functions from customer-queries.ts.
// Pure restructure — zero behavioral change. tenantId is mapped to businessId
// before every call.
//
// Design source: velora-ventas.adapter.ts (composition over inheritance).
// The adapter is a thin delegation layer: it doesn't add logic, it translates shapes.

import type {
  CustomerBackend,
  FindCustomerInput,
  CustomerSearchResult,
  ListCustomersInput,
  ListCustomersResult,
  UpsertCustomerInput,
  CustomerMutationRecord,
  DeleteCustomerInput,
  DeleteCustomerOutput,
} from "./customer-backend.port";
import { findCustomers, upsertCustomer } from "./customer-queries";
import { prisma } from "@/lib/prisma";
import { deleteCustomerUseCase } from "@/application/use-cases/delete-customer.use-case";
import { prismaCustomerRepository } from "@/infrastructure/persistence/prisma-customer.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

const CUSTOMER_DELETE_ACTION = getServerActionMeta("customer.delete");

const deleteCustomer = deleteCustomerUseCase({
  customer: prismaCustomerRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

const MCP_ACTOR_USER_ID = "mcp-system";

function mkIdemKey(businessId: string, tool: string, ...parts: (string | null | undefined)[]): string {
  return [businessId, tool, ...parts.map((p) => String(p ?? ""))].join(":");
}

export class VeloraCustomerAdapter implements CustomerBackend {
  async findCustomer(input: FindCustomerInput): Promise<CustomerSearchResult[]> {
    const { tenantId: businessId, name, phone } = input;
    return findCustomers(businessId, { name, phone });
  }

  async listCustomers(input: ListCustomersInput): Promise<ListCustomersResult[]> {
    const { tenantId: businessId, search } = input;
    const rows = await prisma.customer.findMany({
      where: {
        businessId,
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      select: { id: true, name: true, phone: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((c) => ({ id: c.id, name: c.name ?? "", phone: c.phone ?? null }));
  }

  async upsertCustomer(input: UpsertCustomerInput): Promise<CustomerMutationRecord> {
    const { tenantId: businessId, customerId, name, phone, email, address, postalCode, city } = input;
    return upsertCustomer({ businessId, customerId, name, phone, email, address, postalCode, city });
  }

  async deleteCustomer(input: DeleteCustomerInput): Promise<DeleteCustomerOutput> {
    const { tenantId: businessId, customerId } = input;
    const idemKey = mkIdemKey(businessId, "delete_customer", customerId);
    const result = await deleteCustomer.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      customerId,
      idempotencyKey: idemKey,
      actionMeta: CUSTOMER_DELETE_ACTION,
    });
    if (result.outcome === "replayed") return result.body as DeleteCustomerOutput;
    if (result.outcome === "not_found") throw new Error("CUSTOMER_NOT_FOUND");
    if (result.outcome === "has_history") {
      return { outcome: "has_history", invoiceCount: result.invoiceCount, saleCount: result.saleCount };
    }
    if (result.outcome !== "deleted") throw new Error(`Unexpected outcome: ${result.outcome}`);
    return { outcome: "deleted", ok: true };
  }
}
