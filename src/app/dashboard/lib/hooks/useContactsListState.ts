"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ContactRow, ChatHistoryEntry } from "../types";
import { useDashboardLang } from "../DashboardLangContext";

type ClientDraft = { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string };
type SupplierDraft = { name: string; phone: string; email: string; contactName: string; leadTimeDays: string };

const EMPTY_CLIENT_DRAFT: ClientDraft = { firstName: "", lastName: "", phone: "", email: "", taxId: "", ivaCondition: "", address: "", postalCode: "", city: "", dni: "" };
const EMPTY_SUPPLIER_DRAFT: SupplierDraft = { name: "", phone: "", email: "", contactName: "", leadTimeDays: "3" };

interface UseContactsListStateArgs {
  isClients: boolean;
  clients: ContactRow[];
  manufacturers: ContactRow[];
  clientDrafts: Record<string, ClientDraft>;
  setClientDrafts: (updater: (current: Record<string, ClientDraft>) => Record<string, ClientDraft>) => void;
  supplierDrafts: Record<string, SupplierDraft>;
  setSupplierDrafts: (updater: (current: Record<string, SupplierDraft>) => Record<string, SupplierDraft>) => void;
  newClient: ClientDraft;
  setNewClient: (updater: (current: ClientDraft) => ClientDraft) => void;
  newSupplier: SupplierDraft;
  setNewSupplier: (updater: (current: SupplierDraft) => SupplierDraft) => void;
  newClientSheetRequestId: number;
  savedClientId: string | null;
  onClientSaved: (id: string) => void;
  savedSupplierId: string | null;
  onSupplierSaved: (id: string) => void;
  deleteClient: (id: string) => Promise<void>;
  deleteSupplier: (id: string) => Promise<void>;
  updateClientField: (id: string, field: "name" | "phone" | "email" | "taxId" | "ivaCondition" | "address" | "postalCode" | "city", nextValue: string, currentValue: string | null | undefined) => void;
  updateClientAll: (id: string, patch: { name?: string | null; phone?: string | null; email?: string | null; taxId?: string | null; ivaCondition?: string | null; address?: string | null; postalCode?: string | null; city?: string | null }) => Promise<void>;
  updateSupplierField: (id: string, field: "name" | "phone" | "email" | "contactName" | "leadTimeDays", nextValue: string, currentValue: string | null | undefined) => void;
  updateSupplierAll: (id: string, patch: { name?: string | null; phone?: string | null; email?: string | null; contactName?: string | null; leadTimeDays?: number | null }) => Promise<void>;
  handleCreateClient: (event: FormEvent<HTMLFormElement>, onSuccess?: () => void) => void;
  handleCreateSupplier: (event: FormEvent<HTMLFormElement>, onSuccess?: () => void) => void;
  onImportSuccess: () => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
}

export function useContactsListState({
  isClients,
  clients,
  manufacturers,
  setClientDrafts,
  setSupplierDrafts,
  newClient,
  setNewClient,
  newSupplier,
  setNewSupplier,
  newClientSheetRequestId,
  savedClientId,
  onClientSaved,
  savedSupplierId,
  onSupplierSaved,
  deleteClient,
  deleteSupplier,
  updateClientField,
  updateClientAll,
  updateSupplierField,
  updateSupplierAll,
  handleCreateClient,
  handleCreateSupplier,
  onImportSuccess,
  appendChatHistoryEntry,
}: UseContactsListStateArgs) {
  const { t } = useDashboardLang();
  const [showSheet, setShowSheet] = useState(false);
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [savingContactId, setSavingContactId] = useState<string | null>(null);
  const [savedContactId, setSavedContactId] = useState<string | null>(null);
  const [errorContactId, setErrorContactId] = useState<string | null>(null);

  // --- Escape key: close detail sheet ---
  useEffect(() => {
    if (!selectedContactId) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelectedContactId(null); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [selectedContactId]);

  // --- helpers (defined before effects that reference them) ---
  function hasDirtyContactDraft() {
    if (isClients) {
      return Object.values(newClient).some((value) => value.trim().length > 0);
    }
    const { name, phone, email, contactName } = newSupplier;
    return [name, phone, email, contactName].some((value) => value.trim().length > 0);
  }

  function resetContactSheet() {
    if (hasDirtyContactDraft()) {
      appendChatHistoryEntry(
        "reply",
        isClients ? t("Customer creation cancelled.", "Alta de cliente cancelada.") : t("Supplier creation cancelled.", "Alta de proveedor cancelada.")
      );
    }
    setShowSheet(false);
    setNewClient(() => EMPTY_CLIENT_DRAFT);
    setNewSupplier(() => EMPTY_SUPPLIER_DRAFT);
  }

  // --- Escape key: close create sheet ---
  const resetContactSheetRef = useRef(resetContactSheet);
  resetContactSheetRef.current = resetContactSheet;

  useEffect(() => {
    if (!showSheet) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") resetContactSheetRef.current(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [showSheet]);

  // --- Open sheet when requested externally ---
  useEffect(() => {
    if (!isClients) return;
    if (newClientSheetRequestId <= 0) return;
    setShowSheet(true);
  }, [isClients, newClientSheetRequestId]);

  // --- Scroll to newly saved contact ---
  const prevSavedClientId = useRef<string | null>(null);
  const prevSavedSupplierId = useRef<string | null>(null);
  useEffect(() => {
    const id = isClients ? savedClientId : savedSupplierId;
    const prev = isClients ? prevSavedClientId : prevSavedSupplierId;
    if (id && id !== prev.current) {
      prev.current = id;
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-contact-row-id="${id}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } else if (!id) {
      prev.current = null;
    }
  }, [isClients, savedClientId, savedSupplierId]);

  // --- Field commit helpers ---
  const contactSavingRef = useRef(false);

  function hasFieldChanged(nextValue: string | null | undefined, currentValue: string | null | undefined) {
    return (nextValue ?? "").trim() !== (currentValue ?? "").trim();
  }

  async function handleClientFieldCommit(
    id: string,
    field: "name" | "phone" | "email" | "taxId" | "ivaCondition" | "address" | "postalCode" | "city",
    nextValue: string,
    currentValue: string | null | undefined,
    clientLabel: string
  ) {
    if (!hasFieldChanged(nextValue, currentValue)) return;
    if (contactSavingRef.current) return;
    contactSavingRef.current = true;
    setSavingContactId(id); setSavedContactId(null); setErrorContactId(null);
    try {
      await updateClientField(id, field, nextValue, currentValue);
      onClientSaved(id);
      setSavedContactId(id);
      appendChatHistoryEntry("success", t(`Done, I updated the customer.\n${clientLabel}`, `Listo, actualicé el cliente.\n${clientLabel}`));
    } catch (error) {
      setErrorContactId(id);
      const errMsg = error instanceof Error ? error.message : t("Could not update the customer.", "No se pudo actualizar el cliente.");
      appendChatHistoryEntry("error", errMsg);
    } finally {
      contactSavingRef.current = false;
      setSavingContactId(null);
    }
  }

  async function handleSupplierFieldCommit(
    id: string,
    field: "name" | "phone" | "email" | "contactName" | "leadTimeDays",
    nextValue: string,
    currentValue: string | null | undefined,
    supplierLabel: string
  ) {
    if (!hasFieldChanged(nextValue, currentValue)) return;
    if (contactSavingRef.current) return;
    contactSavingRef.current = true;
    setSavingContactId(id); setErrorContactId(null);
    try {
      await updateSupplierField(id, field, nextValue, currentValue);
      onSupplierSaved(id);
      appendChatHistoryEntry("success", t(`Done, I updated the supplier.\n${supplierLabel}`, `Listo, actualicé el proveedor.\n${supplierLabel}`));
    } catch (error) {
      setErrorContactId(id);
      const errMsg = error instanceof Error ? error.message : t("Could not update the supplier.", "No se pudo actualizar el proveedor.");
      appendChatHistoryEntry("error", errMsg);
    } finally {
      contactSavingRef.current = false;
      setSavingContactId(null);
    }
  }

  // --- Batch save helpers (used by explicit Save button) ---

  async function handleClientSaveAll(
    id: string,
    patch: { name?: string | null; phone?: string | null; email?: string | null; taxId?: string | null; ivaCondition?: string | null; address?: string | null; postalCode?: string | null; city?: string | null },
    clientLabel: string
  ) {
    if (contactSavingRef.current) return;
    contactSavingRef.current = true;
    setSavingContactId(id); setSavedContactId(null); setErrorContactId(null);
    try {
      await updateClientAll(id, patch);
      onClientSaved(id);
      setSavedContactId(id);
      appendChatHistoryEntry("success", t(`Done, I updated the customer.\n${clientLabel}`, `Listo, actualicé el cliente.\n${clientLabel}`));
    } catch (error) {
      setErrorContactId(id);
      const errMsg = error instanceof Error ? error.message : t("Could not update the customer.", "No se pudo actualizar el cliente.");
      appendChatHistoryEntry("error", errMsg);
    } finally {
      contactSavingRef.current = false;
      setSavingContactId(null);
    }
  }

  async function handleSupplierSaveAll(
    id: string,
    patch: { name?: string | null; phone?: string | null; email?: string | null; contactName?: string | null; leadTimeDays?: number | null },
    supplierLabel: string
  ) {
    if (contactSavingRef.current) return;
    contactSavingRef.current = true;
    setSavingContactId(id); setErrorContactId(null);
    try {
      await updateSupplierAll(id, patch);
      onSupplierSaved(id);
      appendChatHistoryEntry("success", t(`Done, I updated the supplier.\n${supplierLabel}`, `Listo, actualicé el proveedor.\n${supplierLabel}`));
    } catch (error) {
      setErrorContactId(id);
      const errMsg = error instanceof Error ? error.message : t("Could not update the supplier.", "No se pudo actualizar el proveedor.");
      appendChatHistoryEntry("error", errMsg);
    } finally {
      contactSavingRef.current = false;
      setSavingContactId(null);
    }
  }

  // --- Delete helpers ---
  function cancelDelete() {
    if (!pendingDeleteId) return;
    appendChatHistoryEntry(
      "reply",
      isClients ? t("Done, I cancelled the customer deletion.", "Listo, cancelé la eliminación del cliente.") : t("Done, I cancelled the supplier deletion.", "Listo, cancelé la eliminación del proveedor.")
    );
    setPendingDeleteId(null);
  }

  async function confirmDelete(id: string) {
    setPendingDeleteId(null);
    setDeleteError(null);
    setDeletingId(id);
    try {
      if (isClients) {
        await deleteClient(id);
      } else {
        await deleteSupplier(id);
      }

      const deletedRow = (isClients ? clients : manufacturers).find((row) => row.id === id);
      const successMsg = isClients
        ? t(`Done, I deleted the customer "${deletedRow?.name ?? "unnamed"}".`, `Listo, eliminé el cliente "${deletedRow?.name ?? "sin nombre"}".`)
        : t(`Done, I deleted the supplier "${deletedRow?.name ?? "unnamed"}".`, `Listo, eliminé el proveedor "${deletedRow?.name ?? "sin nombre"}".`);
      appendChatHistoryEntry("success", successMsg);
      setSelectedContactId(null);
      if (isClients) {
        setClientDrafts((c) => { const next = { ...c }; delete next[id]; return next; });
      } else {
        setSupplierDrafts((c) => { const next = { ...c }; delete next[id]; return next; });
      }
      onImportSuccess();
    } catch (error) {
      const errMsg = error instanceof Error
        ? error.message
        : (isClients ? t("Could not delete the customer.", "No se pudo eliminar el cliente.") : t("Could not delete the supplier.", "No se pudo eliminar el proveedor."));
      appendChatHistoryEntry("error", errMsg);
      setDeleteError(errMsg);
    } finally {
      setDeletingId(null);
    }
  }

  // --- Create and close ---
  async function handleCreateAndClose(e: FormEvent<HTMLFormElement>) {
    const closeSheet = () => setShowSheet(false);
    if (isClients) await handleCreateClient(e, closeSheet);
    else await handleCreateSupplier(e, closeSheet);
  }

  return {
    showSheet,
    setShowSheet,
    search,
    setSearch,
    deletingId,
    pendingDeleteId,
    setPendingDeleteId,
    deleteError,
    setDeleteError,
    selectedContactId,
    setSelectedContactId,
    savingContactId,
    savedContactId,
    errorContactId,
    handleClientFieldCommit,
    handleClientSaveAll,
    handleSupplierFieldCommit,
    handleSupplierSaveAll,
    cancelDelete,
    confirmDelete,
    resetContactSheet,
    hasDirtyContactDraft,
    handleCreateAndClose,
  };
}
