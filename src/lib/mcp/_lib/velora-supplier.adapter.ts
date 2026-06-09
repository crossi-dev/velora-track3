// src/lib/mcp/_lib/velora-supplier.adapter.ts — Velora concrete implementation of SupplierBackend.
//
// Wraps the existing use-case instances from supplier-tools.ts.
// Pure restructure — zero behavioral change. tenantId is mapped to businessId
// before every use-case call.
//
// Design source: velora-catalog.adapter.ts (composition over inheritance).
// The adapter is a thin delegation layer: it doesn't add logic, it translates shapes.

import type {
  SupplierBackend,
  ListSuppliersInput,
  ListSuppliersResult,
  CreateSupplierInput,
  CreateSupplierOutput,
  CreatePurchaseRequestInput,
  CreatePurchaseRequestOutput,
  EditSupplierInput,
  EditSupplierOutput,
  DeleteSupplierInput,
  DeleteSupplierOutput,
} from "./supplier-backend.port";
import { prisma } from "@/lib/prisma";
import { createSupplierUseCase } from "@/application/use-cases/create-supplier.use-case";
import { createPurchaseRequestUseCase } from "@/application/use-cases/create-purchase-request.use-case";
import { updateSupplierUseCase } from "@/application/use-cases/update-supplier.use-case";
import { deleteSupplierUseCase } from "@/application/use-cases/delete-supplier.use-case";
import { prismaSupplierRepository } from "@/infrastructure/persistence/prisma-supplier.repository";
import { prismaPurchaseRequestRepository } from "@/infrastructure/persistence/prisma-purchase-request.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";

// ── Action metas (from canonical mutation contract) ───────────────────────────

const SUPPLIER_CREATE_ACTION = getServerActionMeta("supplier.create");
const SUPPLIER_UPDATE_ACTION = getServerActionMeta("supplier.update");
const SUPPLIER_DELETE_ACTION = getServerActionMeta("supplier.delete");
const PURCHASE_REQUEST_CREATE_ACTION = getServerActionMeta("purchase-request.create");

// ── Use-case instances ────────────────────────────────────────────────────────

const createSupplier = createSupplierUseCase({
  supplier: prismaSupplierRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

const createPurchaseRequest = createPurchaseRequestUseCase({
  purchaseRequest: prismaPurchaseRequestRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

const updateSupplier = updateSupplierUseCase({
  supplier: prismaSupplierRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

const deleteSupplier = deleteSupplierUseCase({
  supplier: prismaSupplierRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── MCP actor constant (system-level MCP caller) ──────────────────────────────

const MCP_ACTOR_USER_ID = "mcp-system";

// ── Idempotency key helper ────────────────────────────────────────────────────

function mkIdemKey(businessId: string, tool: string, ...parts: (string | number | null | undefined)[]): string {
  return [businessId, tool, ...parts.map((p) => String(p ?? ""))].join(":");
}

export class VeloraSupplierAdapter implements SupplierBackend {
  async listSuppliers(input: ListSuppliersInput): Promise<ListSuppliersResult[]> {
    const { tenantId: businessId, search } = input;
    const rows = await prisma.supplier.findMany({
      where: {
        businessId,
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      select: { id: true, name: true, phone: true, contactName: true },
      orderBy: { name: "asc" },
      take: 50,
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      phone: s.phone ?? null,
      contactName: s.contactName ?? null,
    }));
  }

  async createSupplier(input: CreateSupplierInput): Promise<CreateSupplierOutput> {
    const { tenantId: businessId, name, phone, email, contactName, leadTimeDays } = input;
    const idemKey = mkIdemKey(businessId, "create_supplier", name);
    const result = await createSupplier.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      name,
      phone: phone ?? null,
      email: email ?? null,
      contactName: contactName ?? null,
      leadTimeDays: leadTimeDays ?? null,
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta: SUPPLIER_CREATE_ACTION,
    });

    if (result.outcome === "replayed") {
      // Replayed responses carry the original body — pass through as-is.
      return result.body as CreateSupplierOutput;
    }
    if (result.outcome !== "created") {
      throw new Error(`Unexpected outcome: ${result.outcome}`);
    }
    const s = result.supplier;
    return {
      id: s.id,
      name: s.name,
      phone: s.phone,
      email: s.email,
      contactName: s.contactName,
      leadTimeDays: s.leadTimeDays,
    };
  }

  async createPurchaseRequest(input: CreatePurchaseRequestInput): Promise<CreatePurchaseRequestOutput> {
    const { tenantId: businessId, supplierId, supplierName, itemName, quantity, unitPrice } = input;
    const idemKey = mkIdemKey(
      businessId,
      "create_purchase_request",
      supplierId ?? supplierName,
      itemName,
      String(quantity),
      String(unitPrice),
    );
    const result = await createPurchaseRequest.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      actorEmployeeId: null,
      supplierId: supplierId ?? null,
      supplierName: supplierName ?? null,
      itemName,
      quantity,
      unitPrice,
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta: PURCHASE_REQUEST_CREATE_ACTION,
    });

    if (result.outcome === "replayed") {
      return result.body as CreatePurchaseRequestOutput;
    }
    if (result.outcome !== "created") {
      throw new Error(`Unexpected outcome: ${result.outcome}`);
    }
    const r = result.request;
    return { id: r.id, requestNumber: r.requestNumber, ok: true };
  }

  async editSupplier(input: EditSupplierInput): Promise<EditSupplierOutput> {
    const { tenantId: businessId, supplierId, name, phone, email, contactName, leadTimeDays } = input;
    const idemKey = mkIdemKey(businessId, "edit_supplier", supplierId, name, String(phone ?? ""), String(email ?? ""), String(contactName ?? ""), String(leadTimeDays ?? ""));
    const result = await updateSupplier.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      supplierId,
      name,
      phone: phone ?? undefined,
      email: email ?? undefined,
      contactName: contactName ?? undefined,
      leadTimeDays: leadTimeDays ?? undefined,
      idempotencyKey: idemKey,
      requestBody: input,
      actionMeta: SUPPLIER_UPDATE_ACTION,
    });
    if (result.outcome === "replayed") return result.body as EditSupplierOutput;
    if (result.outcome !== "updated") throw new Error(`Unexpected outcome: ${result.outcome}`);
    return { supplierId, ok: true };
  }

  async deleteSupplier(input: DeleteSupplierInput): Promise<DeleteSupplierOutput> {
    const { tenantId: businessId, supplierId } = input;
    const idemKey = mkIdemKey(businessId, "delete_supplier", supplierId);
    const result = await deleteSupplier.execute({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      supplierId,
      idempotencyKey: idemKey,
      actionMeta: SUPPLIER_DELETE_ACTION,
    });
    if (result.outcome === "replayed") return result.body as DeleteSupplierOutput;
    if (result.outcome === "not_found") throw new Error("SUPPLIER_NOT_FOUND");
    if (result.outcome !== "deleted") throw new Error(`Unexpected outcome: ${result.outcome}`);
    return { supplierId, ok: true };
  }
}
