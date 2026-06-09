"use client";

import { useState, useEffect, type FormEvent } from "react";
import { buildCustomerFullName } from "./utils";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { useDashboardLang } from "../DashboardLangContext";
import type {
  ChatHistoryEntry,
  TabKey
} from "../types";

interface useContactsUIOptions {
  businessId: string | null;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  markUpdated: (key: string) => void;
  setActiveTab: (tab: TabKey) => void;
  setPageError: (msg: string | null) => void;
  setSuccessNotice: (msg: string | null) => void;
  setErrorNotice: (msg: string | null) => void;
  setUndoAction?: (fn: (() => Promise<void>) | null) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
}

export function useContactsUI(opts: useContactsUIOptions) {
  const { businessId, loadBusiness, markUpdated, setActiveTab, setSuccessNotice, setErrorNotice, setUndoAction, appendChatHistoryEntry } = opts;
  const { t } = useDashboardLang();

  // New Client Form
  const [newClient, setNewClient] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    taxId: "",
    ivaCondition: "",
    address: "",
    postalCode: "",
    city: "",
    dni: "",
  });
  const [clientSaving, setClientSaving] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [clientNotice, setClientNotice] = useState<string | null>(null);
  const [newClientSheetRequestId, setNewClientSheetRequestId] = useState(0);

  // New Supplier Form
  const [newSupplier, setNewSupplier] = useState({
    name: "",
    phone: "",
    email: "",
    contactName: "",
    leadTimeDays: "3",
  });
  const [supplierSaving, setSupplierSaving] = useState(false);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const [supplierNotice, setSupplierNotice] = useState<string | null>(null);

  useEffect(() => {
    const isEmpty = !newClient.firstName && !newClient.lastName && !newClient.phone && !newClient.email && !newClient.taxId && !newClient.ivaCondition && !newClient.address && !newClient.postalCode && !newClient.city && !newClient.dni;
    if (isEmpty) {
      setClientError(null);
      setClientNotice(null);
    }
  }, [newClient]);

  useEffect(() => {
    const isEmpty = !newSupplier.name && !newSupplier.phone && !newSupplier.email && !newSupplier.contactName;
    if (isEmpty) {
      setSupplierError(null);
      setSupplierNotice(null);
    }
  }, [newSupplier]);

  async function handleCreateClient(event: FormEvent<HTMLFormElement>, onSuccess?: () => void) {
    event.preventDefault();
    if (!businessId || clientSaving) return;

    const fullName = buildCustomerFullName(newClient.firstName, newClient.lastName);
    if (!fullName) {
      setClientError(t("Name is required.", "El nombre es obligatorio."));
      return;
    }

    setClientSaving(true);
    setClientError(null);
    setClientNotice(null);
    try {
      await executeDashboardAction("customer.create", {
        businessId,
        name: fullName,
        phone: newClient.phone || null,
        email: newClient.email || null,
        taxId: newClient.taxId || null,
        ivaCondition: newClient.ivaCondition || null,
        address: newClient.address || null,
        postalCode: newClient.postalCode || null,
        city: newClient.city || null,
        dni: newClient.dni || null,
      });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("clients");
      const successMsg = t("Done, I added the customer.", "Listo, agregué el cliente.");
      setSuccessNotice(successMsg);
      setErrorNotice(null);
      setClientNotice(successMsg);
      setNewClient({ firstName: "", lastName: "", phone: "", email: "", taxId: "", ivaCondition: "", address: "", postalCode: "", city: "", dni: "" });
      // Server's undo customer target deletes the most-recently-created
      // customer (if it has no sales). Wire it so the user gets a Deshacer button.
      setUndoAction?.(async () => {
        await executeDashboardAction("undo.execute", { target: "customer", count: 1 });
        await loadBusiness({ silent: true, force: true }).catch(() => {});
        appendChatHistoryEntry("success", t("Customer deleted.", "Cliente eliminado."));
      });
      onSuccess?.();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : t("Could not create the customer.", "No se pudo crear el cliente.");
      setClientError(errMsg);
      appendChatHistoryEntry("error", errMsg);
    } finally {
      setClientSaving(false);
    }
  }

  async function handleCreateSupplier(event: FormEvent<HTMLFormElement>, onSuccess?: () => void) {
    event.preventDefault();
    if (!businessId || supplierSaving) return;

    if (!newSupplier.name.trim()) {
      setSupplierError(t("Name is required.", "El nombre es obligatorio."));
      return;
    }

    setSupplierSaving(true);
    setSupplierError(null);
    setSupplierNotice(null);
    try {
      await executeDashboardAction("supplier.create", {
        businessId,
        name: newSupplier.name.trim(),
        phone: newSupplier.phone || null,
        email: newSupplier.email || null,
        contactName: newSupplier.contactName || null,
      });

      await loadBusiness({ silent: true, force: true }).catch(() => {});
      markUpdated("suppliers");
      const successMsg = t("Done, I added the supplier.", "Listo, agregué el proveedor.");
      setSuccessNotice(successMsg);
      setErrorNotice(null);
      setSupplierNotice(successMsg);
      setNewSupplier({ name: "", phone: "", email: "", contactName: "", leadTimeDays: "3" });
      // Server's undo supplier target deletes the most-recently-created
      // supplier within the 24h cutoff.
      setUndoAction?.(async () => {
        await executeDashboardAction("undo.execute", { target: "supplier", count: 1 });
        await loadBusiness({ silent: true, force: true }).catch(() => {});
        appendChatHistoryEntry("success", t("Supplier deleted.", "Proveedor eliminado."));
      });
      onSuccess?.();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : t("Could not create the supplier.", "No se pudo crear el proveedor.");
      setSupplierError(errMsg);
      appendChatHistoryEntry("error", errMsg);
    } finally {
      setSupplierSaving(false);
    }
  }

  function openNewClientHelper() {
    setActiveTab("clients");
    setNewClient({ firstName: "", lastName: "", phone: "", email: "", taxId: "", ivaCondition: "", address: "", postalCode: "", city: "", dni: "" });
    setNewClientSheetRequestId(curr => curr + 1);
  }

  return {
    newClient, setNewClient,
    clientSaving, clientError, clientNotice,
    newClientSheetRequestId,
    handleCreateClient,
    newSupplier, setNewSupplier,
    supplierSaving, supplierError, supplierNotice,
    handleCreateSupplier,
    openNewClientHelper
  };
}
