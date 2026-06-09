"use client";

import { type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { ContactRow as ContactRowData } from "@/domain";
import type { TabKey, InvoiceRecord, ChatHistoryEntry } from "../lib/types";
import { ClientDetailSheet } from "./ClientsSubTab";
import { SupplierDetailSheet } from "./SuppliersSubTab";
import { ContactCreateSheet } from "./ContactCreateSheet";
import { ContactsList } from "./ContactsList";
import { ImportButton } from "./ImportButton";
import { useContactsListState } from "../lib/hooks/useContactsListState";
import { SectionMarker } from "./v2/SectionMarker";
import { useBusinessActionsContext } from "../lib/contexts";

interface ContactsTabProps {
  activeTab: TabKey;
  clients: ContactRowData[];
  clientDrafts: Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>;
  setClientDrafts: (updater: (current: Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>) => Record<string, { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }>) => void;
  manufacturers: ContactRowData[];
  supplierDrafts: Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>;
  setSupplierDrafts: (updater: (current: Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>) => Record<string, { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }>) => void;
  newSupplier: { name: string; phone: string; email: string; contactName: string; leadTimeDays: string };
  setNewSupplier: (updater: (current: { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }) => { name: string; phone: string; email: string; contactName: string; leadTimeDays: string }) => void;
  supplierSaving: boolean;
  supplierError: string | null;
  supplierNotice: string | null;
  newClient: { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string };
  setNewClient: (updater: (current: { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }) => { firstName: string; lastName: string; phone: string; email: string; taxId: string; ivaCondition: string; address: string; postalCode: string; city: string; dni: string }) => void;
  newClientSheetRequestId: number;
  clientSaving: boolean;
  clientError: string | null;
  clientNotice: string | null;
  handleCreateClient: (event: FormEvent<HTMLFormElement>, onSuccess?: () => void) => void;
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
  handleCreateSupplier: (event: FormEvent<HTMLFormElement>, onSuccess?: () => void) => void;
  onImportSuccess: () => void;
  invoices: InvoiceRecord[];
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root
export function ContactsTab({
  activeTab,
  clients,
  clientDrafts,
  setClientDrafts,
  manufacturers,
  supplierDrafts,
  setSupplierDrafts,
  newSupplier,
  setNewSupplier,
  supplierSaving,
  supplierError,
  supplierNotice,
  newClient,
  setNewClient,
  newClientSheetRequestId,
  clientSaving,
  clientError,
  clientNotice,
  handleCreateClient,
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
  handleCreateSupplier,
  onImportSuccess,
  invoices,
  appendChatHistoryEntry,
  moneyFmt,
  formatDate,
  t,
}: ContactsTabProps) {
  const { performImport, reloadData } = useBusinessActionsContext();
  const isClients = activeTab === "clients";

  const {
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
    handleClientSaveAll,
    handleSupplierSaveAll,
    cancelDelete,
    confirmDelete,
    resetContactSheet,
    handleCreateAndClose,
  } = useContactsListState({
    isClients,
    clients,
    manufacturers,
    clientDrafts,
    setClientDrafts,
    supplierDrafts,
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
  });

  const rows = isClients ? clients : manufacturers;
  const bothEmpty = clients.length === 0 && manufacturers.length === 0;
  const selectedRow = selectedContactId ? rows.find((r) => r.id === selectedContactId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      {/* v2 editorial header */}
      <div className="flex flex-col gap-1.5">
        <SectionMarker label={t("Operations", "Operaciones")} number="04" />
        <h1
          className="t-display-3"
          style={{ color: "var(--tone-strong)", margin: 0 }}
        >
          {isClients ? t("Clients", "Clientes") : t("Suppliers", "Proveedores")}
        </h1>
      </div>

      {deleteError && (
        <div className="rounded-token-md border px-3.5 py-2.5" style={{ borderColor: "var(--danger-border)", backgroundColor: "var(--danger-soft)" }}>
          <p className="text-caption" style={{ color: "var(--danger)" }}>
            {deleteError}
          </p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setDeleteError(null)}
            className="text-caption h-auto p-0 mt-1 rounded-none"
          >
            {t("Close", "Cerrar")}
          </Button>
        </div>
      )}

      <ContactsList
        isClients={isClients}
        rows={rows}
        bothEmpty={bothEmpty}
        search={search}
        setSearch={setSearch}
        setShowSheet={setShowSheet}
        setSelectedContactId={setSelectedContactId}
        t={t}
      />
      <ImportButton
        type={isClients ? "customers" : "suppliers"}
        label={t("Import", "Importar")}
        performImport={performImport}
        onSuccess={reloadData}
        appendChatHistoryEntry={appendChatHistoryEntry}
        tertiary
      />

      {selectedRow && isClients && (
        <ClientDetailSheet
          key={selectedRow.id}
          row={selectedRow}
          clientDrafts={clientDrafts}
          setClientDrafts={setClientDrafts}
          savingContactId={savingContactId}
          savedContactId={savedContactId}
          errorContactId={errorContactId}
          pendingDeleteId={pendingDeleteId}
          deletingId={deletingId}
          invoices={invoices}
          onClose={() => setSelectedContactId(null)}
          onSaveAll={handleClientSaveAll}
          onRequestDelete={setPendingDeleteId}
          onConfirmDelete={(id) => void confirmDelete(id)}
          onCancelDelete={cancelDelete}
          moneyFmt={moneyFmt}
          formatDate={formatDate}
          t={t}
        />
      )}

      {selectedRow && !isClients && (
        <SupplierDetailSheet
          key={selectedRow.id}
          row={selectedRow}
          supplierDrafts={supplierDrafts}
          setSupplierDrafts={setSupplierDrafts}
          savingContactId={savingContactId}
          savedContactId={savedContactId}
          errorContactId={errorContactId}
          pendingDeleteId={pendingDeleteId}
          deletingId={deletingId}
          onClose={() => setSelectedContactId(null)}
          onSaveAll={handleSupplierSaveAll}
          onRequestDelete={setPendingDeleteId}
          onConfirmDelete={(id) => void confirmDelete(id)}
          onCancelDelete={cancelDelete}
          t={t}
        />
      )}

      {showSheet && (
        <ContactCreateSheet
          isClients={isClients}
          newClient={newClient}
          setNewClient={setNewClient}
          clientSaving={clientSaving}
          clientError={clientError}
          clientNotice={clientNotice}
          newSupplier={newSupplier}
          setNewSupplier={setNewSupplier}
          supplierSaving={supplierSaving}
          supplierError={supplierError}
          supplierNotice={supplierNotice}
          resetContactSheet={resetContactSheet}
          handleCreateAndClose={handleCreateAndClose}
          t={t}
        />
      )}
    </div>
  );
}
