import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { normalizeInput } from "../../../lib/normalize";
import { nextBusinessCounter } from "@/infrastructure/shared/business-counter";

type PurchaseRequestBusiness = {
  name: string;
  cuit: string | null;
  address: string | null;
  currency: string;
};

type PurchaseRequestSupplier = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contactName: string | null;
};

type PurchaseRequestCounterClient = {
  businessCounter: {
    upsert: Prisma.TransactionClient["businessCounter"]["upsert"];
  };
  purchaseRequest: {
    findMany: Prisma.TransactionClient["purchaseRequest"]["findMany"];
    create: Prisma.TransactionClient["purchaseRequest"]["create"];
  };
};

export type PurchaseRequestPayload = {
  business: {
    name: string;
    cuit: string | null;
    address: string | null;
    currency: string;
  };
  supplier: {
    name: string;
    email: string | null;
    phone: string | null;
    contactName: string | null;
  };
  request: {
    id: string;
    requestNumber: string;
    date: string;
    items: Array<{
      itemName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    total: number;
  };
};

export type PurchaseRequestCreateInput = {
  itemName: string;
  quantity: number;
  unitPrice: number;
};

export type CreatedPurchaseRequest = {
  request: {
    id: string;
    requestNumber: string;
    issuedAt: string;
    currency: string;
    totalAmount: number;
    payload: PurchaseRequestPayload;
  };
  auditMeta: {
    requestId: string;
    requestNumber: string;
    supplierId: string;
    supplierName: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
  };
};

function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseNonNegativeNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function nextPurchaseRequestSequenceNumber(tx: PurchaseRequestCounterClient, businessId: string) {
  const counterValue = await nextBusinessCounter(tx, businessId, "purchase-request");

  if (Number.isFinite(counterValue) && counterValue > 0) {
    return counterValue;
  }

  const existingRequests = await tx.purchaseRequest.findMany({
    where: { businessId },
    select: { requestNumber: true },
  });

  const lastSequence = existingRequests.reduce((max, row) => {
    const raw = typeof row.requestNumber === "string" ? row.requestNumber : "";
    const numeric = Number(raw.split("-").pop());
    return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
  }, 0);

  return Math.max(1, lastSequence + 1);
}

export function normalizePurchaseRequestCreateInput(input: {
  itemName: unknown;
  quantity: unknown;
  unitPrice: unknown;
}): PurchaseRequestCreateInput {
  const itemName = normalizeInput(input.itemName);
  if (!itemName) {
    throw new Error("PURCHASE_REQUEST_ITEM_REQUIRED");
  }

  const quantity = parsePositiveInteger(input.quantity);
  if (quantity === null) {
    throw new Error("PURCHASE_REQUEST_QUANTITY_INVALID");
  }

  const unitPrice = parseNonNegativeNumber(input.unitPrice);
  if (unitPrice === null) {
    throw new Error("PURCHASE_REQUEST_UNIT_PRICE_INVALID");
  }

  return {
    itemName,
    quantity,
    unitPrice,
  };
}

function buildPurchaseRequestPayload(args: {
  business: PurchaseRequestBusiness;
  supplier: PurchaseRequestSupplier;
  requestId: string;
  requestNumber: string;
  issuedAt: Date;
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
}): PurchaseRequestPayload {
  return {
    business: {
      name: args.business.name,
      cuit: args.business.cuit,
      address: args.business.address,
      currency: args.business.currency,
    },
    supplier: {
      name: args.supplier.name,
      email: args.supplier.email,
      phone: args.supplier.phone,
      contactName: args.supplier.contactName,
    },
    request: {
      id: args.requestId,
      requestNumber: args.requestNumber,
      date: args.issuedAt.toISOString(),
      items: [
        {
          itemName: args.itemName,
          quantity: args.quantity,
          unitPrice: args.unitPrice,
          subtotal: args.totalAmount,
        },
      ],
      total: args.totalAmount,
    },
  };
}

export async function createPurchaseRequestInTransaction(
  tx: PurchaseRequestCounterClient,
  args: {
    businessId: string;
    business: PurchaseRequestBusiness;
    supplier: PurchaseRequestSupplier | null;
    input: PurchaseRequestCreateInput;
    issuedAt?: Date;
  }
): Promise<CreatedPurchaseRequest> {
  if (!args.supplier) {
    throw new Error("SUPPLIER_REQUIRED");
  }

  const requestId = randomUUID().replace(/-/g, "");
  const issuedAt = args.issuedAt ?? new Date();
  const totalAmount = Number((args.input.quantity * args.input.unitPrice).toFixed(2));
  const sequenceNumber = await nextPurchaseRequestSequenceNumber(tx, args.businessId);
  const requestNumber = `OC-${String(sequenceNumber).padStart(6, "0")}`;
  const payload = buildPurchaseRequestPayload({
    business: args.business,
    supplier: args.supplier,
    requestId,
    requestNumber,
    issuedAt,
    itemName: args.input.itemName,
    quantity: args.input.quantity,
    unitPrice: args.input.unitPrice,
    totalAmount,
  });

  await tx.purchaseRequest.create({
    data: {
      id: requestId,
      businessId: args.businessId,
      supplierId: args.supplier.id,
      requestNumber,
      issuedAt,
      currency: args.business.currency,
      totalAmount,
      payloadJson: JSON.stringify(payload),
      createdAt: issuedAt,
    },
  });

  return {
    request: {
      id: requestId,
      requestNumber,
      issuedAt: issuedAt.toISOString(),
      currency: args.business.currency,
      totalAmount,
      payload,
    },
    auditMeta: {
      requestId,
      requestNumber,
      supplierId: args.supplier.id,
      supplierName: args.supplier.name,
      itemName: args.input.itemName,
      quantity: args.input.quantity,
      unitPrice: args.input.unitPrice,
      totalAmount,
    },
  };
}
