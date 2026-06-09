import type { NextResponse } from "next/server";
import { handleUndoSale } from "./undo-handlers/sale";
import { handleUndoCustomer } from "./undo-handlers/customer";
import { handleUndoStock } from "./undo-handlers/stock";
import { handleUndoProduct } from "./undo-handlers/product";
import { handleUndoSupplier } from "./undo-handlers/supplier";
import { handleUndoCashMovement } from "./undo-handlers/cash-movement";
import { handleUndoProductCreate } from "./undo-handlers/product-create";
import type { UndoHandlerContext, UndoTarget } from "./undo-handler-context";

export async function dispatchUndo(
  target: UndoTarget,
  ctx: UndoHandlerContext
): Promise<NextResponse> {
  switch (target) {
    case "sale":
      return handleUndoSale(ctx);
    case "customer":
      return handleUndoCustomer(ctx);
    case "stock":
      return handleUndoStock(ctx);
    case "product":
      return handleUndoProduct(ctx);
    case "supplier":
      return handleUndoSupplier(ctx);
    case "cash-movement":
      return handleUndoCashMovement(ctx);
    case "product-create":
      return handleUndoProductCreate(ctx);
    default:
      return ctx.releaseAndReturnError({ error: "Objetivo inválido." }, 400);
  }
}
