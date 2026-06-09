"use client";

import { useState } from "react";
import { tLang } from "../DashboardLangContext";
import { executeDashboardAction } from "../actions/executeDashboardAction";

interface useContactsOptions {
  businessId: string | null;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  markUpdated: (key: string) => void;
  setPageError: (msg: string | null) => void;
}

export function useContacts(opts: useContactsOptions) {
  const [clientDrafts, setClientDrafts] = useState<Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>>({});
  const [supplierDrafts, setSupplierDrafts] = useState<Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>>({});

  const { businessId, loadBusiness, markUpdated } = opts;

  async function updateClientField(clientId: string, field: string, nextValue: string, currentValue: string | null | undefined) {
    if (!businessId) return;
    if (nextValue === (currentValue ?? "")) return;
    try {
      await executeDashboardAction("customer.update", { id: clientId, [field]: nextValue });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("clients");
    } catch (error) {
      const msg = error instanceof Error ? error.message : tLang("Could not update the customer.", "No se pudo actualizar el cliente.");
      opts.setPageError(msg);
      throw error;
    }
  }

  /** Batch-update all changed customer fields in one PATCH call. */
  async function updateClientAll(
    clientId: string,
    patch: Omit<import("../actions/contracts-payloads").CustomerUpdatePayload, "id">
  ) {
    if (!businessId) return;
    try {
      await executeDashboardAction("customer.update", { id: clientId, ...patch });
      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("clients");
    } catch (error) {
      const msg = error instanceof Error ? error.message : tLang("Could not update the customer.", "No se pudo actualizar el cliente.");
      opts.setPageError(msg);
      throw error;
    }
  }

  async function updateSupplierField(supplierId: string, field: string, nextValue: string, currentValue: string | null | undefined) {
    if (!businessId) return;
    if (nextValue === (currentValue ?? "")) return;
    try {
      await executeDashboardAction("supplier.update", { id: supplierId, [field]: nextValue });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("suppliers");
    } catch (error) {
      const msg = error instanceof Error ? error.message : tLang("Could not update the supplier.", "No se pudo actualizar el proveedor.");
      opts.setPageError(msg);
      throw error;
    }
  }

  /** Batch-update all changed supplier fields in one PATCH call. */
  async function updateSupplierAll(
    supplierId: string,
    patch: Omit<import("../actions/contracts-payloads").SupplierUpdatePayload, "id">
  ) {
    if (!businessId) return;
    try {
      await executeDashboardAction("supplier.update", { id: supplierId, ...patch });
      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("suppliers");
    } catch (error) {
      const msg = error instanceof Error ? error.message : tLang("Could not update the supplier.", "No se pudo actualizar el proveedor.");
      opts.setPageError(msg);
      throw error;
    }
  }

  async function deleteClient(clientId: string) {
    if (!businessId) return;
    try {
      await executeDashboardAction("customer.delete", { id: clientId });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("clients");
    } catch (error) {
      const msg = error instanceof Error ? error.message : tLang("Could not delete the customer.", "No se pudo eliminar el cliente.");
      opts.setPageError(msg);
      throw error;
    }
  }

  async function deleteSupplier(supplierId: string) {
    if (!businessId) return;
    try {
      await executeDashboardAction("supplier.delete", { id: supplierId });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("suppliers");
    } catch (error) {
      const msg = error instanceof Error ? error.message : tLang("Could not delete the supplier.", "No se pudo eliminar el proveedor.");
      opts.setPageError(msg);
      throw error;
    }
  }

  return {
    clientDrafts, setClientDrafts,
    supplierDrafts, setSupplierDrafts,
    updateClientField,
    updateClientAll,
    updateSupplierField,
    updateSupplierAll,
    deleteClient,
    deleteSupplier
  };
}
