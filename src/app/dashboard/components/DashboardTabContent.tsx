"use client";

import { lazy, Suspense, useCallback, useMemo } from "react";
import {
  useBusinessDataContext,
  useBusinessActionsContext,
  useChatContext,
  useInputContext,
  useUIContextDashboard,
  useQuickActionsContext,
  useRole,
} from "../lib/contexts";
import { QuickActions } from "./QuickActions";
import { AssistantInput } from "./AssistantInput";
import { InvoiceDetailSheet } from "./InvoiceDetailSheet";
import { TabErrorBoundary } from "./TabErrorBoundary";
import { SkeletonRow } from "./SkeletonRow";
import { SetupChecklist } from "./SetupChecklist";
import type { BusinessCapabilities } from "@/lib/business-capabilities";


const PresupuestoTab = lazy(() => import("./PresupuestoTab").then(m => ({ default: m.PresupuestoTab })));
const InventoryTab = lazy(() => import("./InventoryTab").then(m => ({ default: m.InventoryTab })));
const InvoicesTab = lazy(() => import("./InvoicesTab").then(m => ({ default: m.InvoicesTab })));
const ContactsTab = lazy(() => import("./ContactsTab").then(m => ({ default: m.ContactsTab })));
const SettingsTab = lazy(() => import("./SettingsTab").then(m => ({ default: m.SettingsTab })));
const ServiciosTab = lazy(() => import("./ServiciosTab").then(m => ({ default: m.ServiciosTab })));
// SalesTab is lazy too: it was eagerly imported, forcing its JS into the initial
// bundle even though the default active tab is the chat ("main"). Same pattern as
// the siblings — Suspense boundary lives at the keep-alive render site below.
const SalesTab = lazy(() => import("./SalesTab").then(m => ({ default: m.SalesTab })));
const CustomerConversationsTab = lazy(() => import("./CustomerConversationsTab").then(m => ({ default: m.CustomerConversationsTab })));

interface DashboardTabContentProps {
  /** SSR capability map for the SetupChecklist (owner only). Null for employees or when loading. */
  capabilities?: BusinessCapabilities | null;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function DashboardTabContent({ capabilities }: DashboardTabContentProps = {}) {
  const role = useRole();
  const biz = useBusinessDataContext();
  const actions = useBusinessActionsContext();
  const chat = useChatContext();
  const { input, setInput } = useInputContext();
  const ui = useUIContextDashboard();
  const qa = useQuickActionsContext();

  const {
    activeTab,
    setActiveTab,
    quickAction,
    setQuickAction,
    quickActionSaving,
    quickActionError,
    successNotice,
  } = ui;

  const { business } = biz;

  // Bible §4: facturas viven dentro de Ventas. Click en "Ver factura" desde
  // SalesTab abre InvoiceDetail como sheet inline. El state vive en UIContext
  // para que callers de fuera (Toast post-confirm + action handler invoices.ts)
  // puedan abrir el mismo sheet sin switchear de tab.
  const { invoiceSheetOpen, setInvoiceSheetOpen } = ui;

  const onViewInvoice = useCallback((id: string) => {
    actions.setActiveInvoiceId(id);
    setInvoiceSheetOpen(true);
  }, [actions.setActiveInvoiceId, setInvoiceSheetOpen]);

  const closeInvoiceSheet = useCallback(() => {
    setInvoiceSheetOpen(false);
  }, [setInvoiceSheetOpen]);

  const onManualSale = useCallback(() => setQuickAction("sale"), [setQuickAction]);

  const clientsForAssistant = useMemo(
    () => biz.clients.map((c) => ({ id: c.id, name: c.name })),
    [biz.clients]
  );

  const clientsForBudget = useMemo(
    () => biz.clients.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? "" })),
    [biz.clients]
  );

  const salesLastUpdated = useMemo(
    () => Math.max(biz.lastUpdated.sales ?? 0, biz.lastUpdated.cash ?? 0) || null,
    [biz.lastUpdated.sales, biz.lastUpdated.cash]
  );

  // SetupChecklist: shown to owners on the main tab when capabilities have
  // pending items. Disappears once all 5 items are done (returns null internally).
  const hasProducts = (biz.products?.length ?? 0) > 0;

  // business is guaranteed non-null by the parent guard
  if (!business) return null;

  return (
    <>
      <QuickActions
        quickAction={quickAction}
        setQuickAction={setQuickAction}
        setActiveTab={setActiveTab}
        quickActionSaving={quickActionSaving}
        products={biz.products}
        quickStock={qa.quickStock}
        setQuickStock={qa.setQuickStock}
        quickMovement={qa.quickMovement}
        setQuickMovement={qa.setQuickMovement}
        quickProduct={qa.quickProduct}
        setQuickProduct={qa.setQuickProduct}
        quickSale={qa.quickSale}
        setQuickSale={qa.setQuickSale}
        clients={biz.clients}
        handleQuickStockSubmit={qa.handleQuickStockSubmit}
        handleQuickMovementSubmit={qa.handleQuickMovementSubmit}
        handleQuickProductSubmit={qa.handleQuickProductSubmit}
        handleQuickSaleSubmit={qa.handleQuickSaleSubmit}
        businessCurrency={business.currency}
        t={actions.t}
      />

      {activeTab === "main" ? (
        <>
          {/* SetupChecklist — owner only. Shown above the chat when there are
              pending setup items. Hides automatically once all 5 are done.
              Pattern: Stripe Incremental Onboarding (currently_due).
              Source: https://docs.stripe.com/connect/custom/hosted-onboarding */}
          {role === "owner" && capabilities != null && (
            <SetupChecklist
              capabilities={capabilities}
              hasProducts={hasProducts}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TabKey is a string union; cast mirrors CapabilityBuoyBanner pattern.
              onNavigate={setActiveTab as (tab: string) => void}
            />
          )}
          <AssistantInput
            hideEmptyMark={role === "owner" && capabilities != null}
            input={input}
            setInput={setInput}
            chatHistory={chat.chatHistory}
            traceLoading={chat.traceLoading}
            traceError={chat.traceError}
            loadingParse={chat.loadingParse}
            parseError={chat.parseError}
            parseMissingField={chat.parseMissingField}
            quickActionError={quickActionError}
            successNotice={successNotice}
            parsed={chat.parsed}
            setParsed={chat.setParsed}
            parsedSaleChatCount={chat.parsedSaleChatCount}
            confirming={chat.confirming}
            confirmError={chat.confirmError}
            setConfirmError={chat.setConfirmError}
            assistantReply={chat.assistantReply}
            assistantStockDraft={chat.assistantStockDraft}
            setAssistantStockDraft={chat.setAssistantStockDraft}
            assistantStockSaving={chat.assistantStockSaving}
            assistantStockError={chat.assistantStockError}
            setAssistantStockError={chat.setAssistantStockError}
            cobroQrDraft={chat.cobroQrDraft}
            setCobroQrDraft={chat.setCobroQrDraft}
            appendCobroChatHistoryEntry={chat.appendChatHistoryEntry}
            loadBusiness={actions.reloadData}
            assistantConfirmationRequest={chat.assistantConfirmationRequest}
            assistantConfirmationSubmitting={chat.assistantConfirmationSubmitting}
            assistantConfirmationError={chat.assistantConfirmationError}
            assistantQuestionContext={chat.assistantQuestionContext}
            assistantInputHint={chat.assistantInputHint}
            latestPurchaseRequest={chat.latestPurchaseRequest}
            latestPurchaseRequestPayload={biz.latestPurchaseRequestPayload}
            purchaseActionNotice={chat.purchaseActionNotice}
            setPurchaseActionNotice={chat.setPurchaseActionNotice}
            downloadingPurchaseRequestId={biz.downloadingPurchaseRequestId}
            saleDraftRef={chat.saleDraftRef}
            business={business}
            handleGo={chat.handleGo}
            abortCurrentRequest={chat.abortCurrentRequest}
            handleMissingFieldSubmit={chat.handleMissingFieldSubmit}
            handleCustomerSelect={chat.handleCustomerSelect}
            customerSelectContext={chat.customerSelectContext}
            handleEditParsedSale={chat.handleEditParsedSale}
            handleCancelParsedSale={chat.handleCancelParsedSale}
            handleConfirm={chat.handleConfirm}
            handleConfirmAndSendWhatsapp={chat.handleConfirmAndSendWhatsapp}
            handleAssistantConfirmationConfirm={chat.handleAssistantConfirmationConfirm}
            handleAssistantConfirmationCancel={chat.handleAssistantConfirmationCancel}
            handleAssistantStockDraftDismiss={chat.handleAssistantStockDraftDismiss}
            handleAssistantStockSubmit={chat.handleAssistantStockSubmit}
            updateAssistantStockField={chat.updateAssistantStockField}
            updateAssistantStockItem={chat.updateAssistantStockItem}
            downloadPurchaseRequestPdf={actions.downloadPurchaseRequestPdf}
            sendPurchaseRequestToSupplier={chat.sendPurchaseRequestToSupplier}
            moneyFmt={actions.moneyFmt}
            t={actions.t}
            clients={clientsForAssistant}
            onManualSale={onManualSale}
            catalogNames={biz.products?.map((p: { name: string }) => p.name)}
          />
        </>
      ) : (
        <>
          {/* Sales: keep-alive with display:none to preserve scroll + state */}
          <TabErrorBoundary tabName="sales">
            <div style={{ display: activeTab === "sales" ? "contents" : "none" }}>
              <Suspense fallback={<SkeletonRow count={3} />}>
                <SalesTab
                  business={business}
                  cashMovements={biz.cashMovements}
                  invoices={biz.invoices}
                  sales={biz.sales}
                  currentCash={biz.currentCash}
                  lastUpdatedTimestamp={salesLastUpdated}
                  moneyFmt={actions.moneyFmt}
                  formatDate={actions.formatDate}
                  formatTime={actions.formatTime}
                  movementDescriptionLabel={actions.movementDescriptionLabel}
                  t={actions.t}
                  onViewInvoice={onViewInvoice}
                />
              </Suspense>
            </div>
          </TabErrorBoundary>

          {activeTab === "budget" && (
            <TabErrorBoundary tabName="budget">
              <Suspense fallback={<SkeletonRow count={3} />}>
                <PresupuestoTab
                  business={business}
                  products={biz.products}
                  clients={clientsForBudget}
                  moneyFmt={actions.moneyFmt}
                  t={actions.t}
                />
              </Suspense>
            </TabErrorBoundary>
          )}

          {activeTab === "invoices" && (
            <TabErrorBoundary tabName="invoices">
              <Suspense fallback={<SkeletonRow count={3} />}>
                <InvoicesTab
                  setActiveTab={setActiveTab}
                  business={business}
                  invoices={biz.invoices}
                  activeInvoiceId={biz.activeInvoiceId}
                  setActiveInvoiceId={actions.setActiveInvoiceId}
                  invoiceStatusNotice={biz.invoiceStatusNotice}
                  setInvoiceStatusNotice={actions.setInvoiceStatusNotice}
                  downloadingInvoiceId={biz.downloadingInvoiceId}
                  selectedInvoice={biz.selectedInvoice}
                  selectedInvoiceBusiness={biz.selectedInvoiceBusiness}
                  selectedInvoiceCustomer={biz.selectedInvoiceCustomer}
                  selectedInvoiceSale={biz.selectedInvoiceSale}
                  downloadInvoicePdf={actions.downloadInvoicePdf}
                  sendInvoiceByWhatsapp={actions.sendInvoiceByWhatsapp}
                  updateInvoiceStatus={actions.updateInvoiceStatus}
                  appendChatHistoryEntry={chat.appendChatHistoryEntry}
                  moneyFmt={actions.moneyFmt}
                  formatDate={actions.formatDate}
                  t={actions.t}
                />
              </Suspense>
            </TabErrorBoundary>
          )}

          {activeTab === "inventory" && (
            <TabErrorBoundary tabName="inventory">
              <Suspense fallback={<SkeletonRow count={3} />}>
                <InventoryTab
                  business={business}
                  products={biz.products}
                  suppliers={biz.manufacturers}
                  onProductSaved={actions.onProductSaved}
                  inventoryChanges={biz.inventoryChanges}
                  openSellProductHelper={chat.openSellProductHelper}
                  setQuickAction={setQuickAction}
                  updateProduct={actions.updateProduct}
                  deleteProduct={actions.deleteProduct}
                  moneyFmt={actions.moneyFmt}
                  formatDate={actions.formatDate}
                  formatTime={actions.formatTime}
                  t={actions.t}
                />
              </Suspense>
            </TabErrorBoundary>
          )}

          {(activeTab === "clients" || activeTab === "suppliers") && (
            <TabErrorBoundary tabName={activeTab}>
              <Suspense fallback={<SkeletonRow count={3} />}>
                <ContactsTab
                  activeTab={activeTab}
                  clients={biz.clients}
                  clientDrafts={biz.clientDrafts}
                  setClientDrafts={actions.setClientDrafts}
                  manufacturers={biz.manufacturers}
                  supplierDrafts={biz.supplierDrafts}
                  setSupplierDrafts={actions.setSupplierDrafts}
                  newSupplier={biz.newSupplier}
                  setNewSupplier={actions.setNewSupplier}
                  supplierSaving={biz.supplierSaving}
                  supplierError={biz.supplierError}
                  supplierNotice={biz.supplierNotice}
                  newClient={biz.newClient}
                  setNewClient={actions.setNewClient}
                  newClientSheetRequestId={biz.newClientSheetRequestId}
                  clientSaving={biz.clientSaving}
                  clientError={biz.clientError}
                  clientNotice={biz.clientNotice}
                  handleCreateClient={actions.handleCreateClient}
                  savedClientId={biz.savedClientId}
                  onClientSaved={actions.onClientSaved}
                  savedSupplierId={biz.savedSupplierId}
                  onSupplierSaved={actions.onSupplierSaved}
                  deleteClient={actions.deleteClient}
                  deleteSupplier={actions.deleteSupplier}
                  updateClientField={actions.updateClientField}
                  updateClientAll={actions.updateClientAll}
                  updateSupplierField={actions.updateSupplierField}
                  updateSupplierAll={actions.updateSupplierAll}
                  handleCreateSupplier={actions.handleCreateSupplier}
                  onImportSuccess={actions.reloadData}
                  invoices={biz.invoices}
                  appendChatHistoryEntry={chat.appendChatHistoryEntry}
                  moneyFmt={actions.moneyFmt}
                  formatDate={actions.formatDate}
                  t={actions.t}
                />
              </Suspense>
            </TabErrorBoundary>
          )}

          {activeTab === "servicios" && (
            <TabErrorBoundary tabName="servicios">
              <Suspense fallback={<SkeletonRow count={3} />}>
                <ServiciosTab />
              </Suspense>
            </TabErrorBoundary>
          )}

          {activeTab === "conversations" && (
            <TabErrorBoundary tabName="conversations">
              <Suspense fallback={<SkeletonRow count={3} />}>
                <CustomerConversationsTab />
              </Suspense>
            </TabErrorBoundary>
          )}

          {activeTab === "settings" && biz.settingsForm && (
            <TabErrorBoundary tabName="settings">
              <Suspense fallback={<SkeletonRow count={3} />}>
                <SettingsTab
                  business={business}
                  settingsForm={biz.settingsForm}
                  settingsSaving={biz.settingsSaving}
                  settingsError={biz.settingsError}
                  settingsNotice={biz.settingsNotice}
                  updateSettingsField={actions.updateSettingsField}
                  handleSaveSettings={actions.handleSaveSettings}
                  setSettingsForm={actions.setSettingsForm}
                  setSettingsError={actions.setSettingsError}
                  setSettingsNotice={actions.setSettingsNotice}
                  t={actions.t}
                />
              </Suspense>
            </TabErrorBoundary>
          )}
        </>
      )}

      {/* Invoice detail como sheet inline (bible: facturas dentro de Ventas).
          Renderizado por encima de cualquier tab activa. */}
      <InvoiceDetailSheet
        open={invoiceSheetOpen}
        business={business}
        selectedInvoice={biz.selectedInvoice}
        selectedInvoiceBusiness={biz.selectedInvoiceBusiness}
        selectedInvoiceCustomer={biz.selectedInvoiceCustomer}
        selectedInvoiceSale={biz.selectedInvoiceSale}
        invoiceStatusNotice={biz.invoiceStatusNotice}
        setInvoiceStatusNotice={actions.setInvoiceStatusNotice}
        downloadingInvoiceId={biz.downloadingInvoiceId}
        downloadInvoicePdf={actions.downloadInvoicePdf}
        sendInvoiceByWhatsapp={actions.sendInvoiceByWhatsapp}
        updateInvoiceStatus={actions.updateInvoiceStatus}
        appendChatHistoryEntry={chat.appendChatHistoryEntry}
        onClose={closeInvoiceSheet}
        moneyFmt={actions.moneyFmt}
        formatDate={actions.formatDate}
        t={actions.t}
      />
    </>
  );
}
