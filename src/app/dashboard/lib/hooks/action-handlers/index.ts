import type { ActionHandler } from "./types";
import { handleRegisterSale, handleSelectCustomer } from "./sale";
import { handleCreateSupplier, handleCreateCustomer, handleEditSupplier, handleDeleteSupplier, handleEditCustomer, handleDeleteCustomer } from "./contacts";
import { handleEditProduct, handleMultiEditProduct, handleBulkPriceUpdate, handleCreateProduct, handleDeleteProduct } from "./products";
import { handleSelectInvoice, handleUpdateInvoiceStatus, handleSendInvoiceWhatsapp, handleDownloadInvoice } from "./invoices";
import { handleStockLoad, handleRegisterMovement, handleAdjustStock } from "./inventory";
import { handleSelectPurchaseRequest, handleDownloadPurchaseRequest, handleSendPurchaseRequestWhatsapp, handleCreatePurchaseRequest } from "./purchase-requests";
import { handleCreateBudget } from "./budget";
import { handleUndo } from "./undo";
import { handleConfirmCobro } from "./cobro-qr";

export { sendPurchaseRequestToSupplier } from "./purchase-requests";
export type { ActionContext } from "./types";

export const actionHandlers: Record<string, ActionHandler> = {
  register_sale: handleRegisterSale,
  create_supplier: handleCreateSupplier,
  create_customer: handleCreateCustomer,
  multi_edit_product: handleMultiEditProduct,
  edit_product: handleEditProduct,
  bulk_price_update: handleBulkPriceUpdate,
  create_product: handleCreateProduct,
  delete_product: handleDeleteProduct,
  edit_supplier: handleEditSupplier,
  delete_supplier: handleDeleteSupplier,
  edit_customer: handleEditCustomer,
  delete_customer: handleDeleteCustomer,
  select_invoice: handleSelectInvoice,
  update_invoice_status: handleUpdateInvoiceStatus,
  send_invoice_whatsapp: handleSendInvoiceWhatsapp,
  download_invoice: handleDownloadInvoice,
  create_purchase_request: handleCreatePurchaseRequest,
  select_purchase_request: handleSelectPurchaseRequest,
  download_purchase_request: handleDownloadPurchaseRequest,
  send_purchase_request_whatsapp: handleSendPurchaseRequestWhatsapp,
  create_budget: handleCreateBudget,
  stock_load: handleStockLoad,
  adjust_stock: handleAdjustStock,
  select_customer: handleSelectCustomer,
  register_movement: handleRegisterMovement,
  undo: handleUndo,
  confirm_cobro: handleConfirmCobro,
};
