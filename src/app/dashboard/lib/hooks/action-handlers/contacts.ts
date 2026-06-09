import { executeDashboardAction } from "../../actions/executeDashboardAction";
import { toErrorMessage } from "../assistant-chat-utils";
import type { ActionHandlerArgs } from "./types";

export async function handleCreateSupplier({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const supplier = action.supplier as { name: string; phone: string; email: string; contactName: string };
    await executeDashboardAction("supplier.create", { businessId: ctx.businessId!, ...supplier });
    const msg = ctx.t(`Supplier "${supplier.name}" created.`, `Proveedor "${supplier.name}" creado.`);
    ctx.setAssistantReply(msg);
    ctx.notifyChatSuccess?.(msg);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not create the supplier.", "No se pudo crear el proveedor."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleCreateCustomer({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const customer = action.customer as { name?: string; phone?: string; email?: string; taxId?: string; address?: string };
    await executeDashboardAction("customer.create", { businessId: ctx.businessId!, ...customer });
    const details = [customer.name, customer.phone].filter(Boolean).join("\n");
    const missingFields = (
      [
        [customer.phone, "teléfono"],
        [customer.email, "email"],
      ] as [string | undefined, string][]
    ).filter(([v]) => !v).map(([, label]) => label);
    const followUp = missingFields.length > 0
      ? `\n\n¿Querés agregarle ${missingFields.slice(0, -1).join(", ")}${missingFields.length > 1 ? " o " : ""}${missingFields.at(-1)}?`
      : "";
    const msg = ctx.t(`Customer added.\n${details}${followUp}`, `Cliente agregado.\n${details}${followUp}`);
    ctx.setAssistantReply(msg);
    ctx.notifyChatSuccess?.(msg);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not create the customer.", "No se pudo crear el cliente."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleEditSupplier({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const supplier = action.supplier as { id: string; name: string };
    const field = action.field as string;
    const value = action.value as string;
    // id may be "" when created in the same message — fall back to name lookup
    const resolved = supplier.id
      ? ctx.manufacturers.find((s) => s.id === supplier.id)
      : ctx.manufacturers.find((s) => s.name.toLowerCase() === supplier.name.toLowerCase());
    if (!resolved) throw new Error(ctx.t(`Supplier "${supplier.name}" not found.`, `No se encontró el proveedor "${supplier.name}".`));
    const current = resolved;
    // dynamic field lookup on Prisma entity — cast required for index-signature access
    await ctx.updateSupplierField(resolved.id, field, value, current ? ((current as unknown as Record<string, string>)[field] ?? "") : "");
    const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
    const reply = rawAnswerStr ?? ctx.t(`"${supplier.name}" updated.`, `"${supplier.name}" actualizado.`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not update the supplier.", "No se pudo actualizar el proveedor."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleDeleteSupplier({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const supplier = action.supplier as { id: string; name: string };
    // id may be "" when not in snapshot — fall back to name lookup
    const resolved = supplier.id
      ? supplier
      : ctx.manufacturers.find((s) => s.name.toLowerCase() === supplier.name.toLowerCase());
    if (!resolved?.id) throw new Error(ctx.t(`Supplier "${supplier.name}" not found.`, `No se encontró el proveedor "${supplier.name}".`));
    await executeDashboardAction("supplier.delete", { id: resolved.id });
    const reply = ctx.t(`Done, I deleted supplier "${resolved.name}".`, `Listo, eliminé el proveedor "${resolved.name}".`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not delete the supplier.", "No pude eliminar el proveedor."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleDeleteCustomer({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const customer = action.customer as { id: string; name: string };
    // id must be present — the mapper suppresses delete_customer when id is empty.
    if (!customer.id) throw new Error(ctx.t(`Customer "${customer.name}" not found.`, `No se encontró el cliente "${customer.name}".`));
    await executeDashboardAction("customer.delete", { id: customer.id });
    const reply = ctx.t(`Done, I deleted customer "${customer.name}".`, `Listo, eliminé al cliente "${customer.name}".`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not delete the customer.", "No pude eliminar el cliente."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleEditCustomer({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const customer = action.customer as { id: string; name: string };
    const field = action.field as string;
    const value = action.value as string;
    // id may be "" when created in the same message — fall back to name lookup
    const resolved = customer.id
      ? ctx.clients.find((c) => c.id === customer.id)
      : ctx.clients.find((c) => c.name.toLowerCase() === customer.name.toLowerCase());
    if (!resolved) throw new Error(ctx.t(`Customer "${customer.name}" not found.`, `No se encontró el cliente "${customer.name}".`));
    const current = resolved;
    // dynamic field lookup on Prisma entity — cast required for index-signature access
    await ctx.updateClientField(resolved.id, field, value, current ? ((current as unknown as Record<string, string>)[field] ?? "") : "");
    const reply = ctx.t(`Customer updated.\n${customer.name}`, `Cliente actualizado.\n${customer.name}`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not update the customer.", "No se pudo actualizar el cliente."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}
