// src/app/developers/_lib/tool-catalog.ts — Tool catalog data for the
// developer-facing /developers page.
//
// Source of truth: the live `com.somosvelora/velora` MCP connector tool
// list. Pack groupings below are this page's own display organization —
// the tool names, count, and the open_* widget tools are verified against
// the connector's real tool list (tests/vitest/mcp/fiscal-mcp-server.test.ts),
// not invented. There is no fiado/promesa (buy-now-pay-later) flow in this
// business — Velora's sales are cash-or-MercadoPago only.

export interface ToolEntry {
  name: string;
}

export interface ToolPack {
  pack: string;
  subtitle: string;
  tools: ToolEntry[];
}

export const TOOL_PACKS: ToolPack[] = [
  {
    pack: "Fiscal — ARCA/AFIP",
    subtitle: "Facturación electrónica con CAE real",
    tools: [
      { name: "get_fiscal_readiness" },
      { name: "emit_invoice" },
      { name: "emit_nota" },
      { name: "describe_invoice_type" },
      { name: "consultar_comprobante" },
      { name: "consultar_padron" },
      { name: "build_afip_qr" },
      { name: "to_afip_date" },
      { name: "split_iva" },
    ],
  },
  {
    pack: "Pagos — MercadoPago",
    subtitle: "Links de cobro y seguimiento de pagos",
    tools: [
      { name: "connect_mercadopago" },
      { name: "create_tracked_payment_link" },
      { name: "get_payment_intent_status" },
    ],
  },
  {
    pack: "Catálogo & Stock",
    subtitle: "Productos, precios e inventario",
    tools: [
      { name: "query_catalog" },
      { name: "create_product" },
      { name: "edit_product" },
      { name: "delete_product" },
      { name: "stock_load" },
      { name: "adjust_stock" },
      { name: "bulk_price_update" },
      { name: "upload_catalog" },
    ],
  },
  {
    pack: "Ventas, Caja & Reportes",
    subtitle: "Registro de ventas, caja registradora y métricas",
    tools: [
      { name: "register_sale" },
      { name: "return_sale" },
      { name: "register_movement" },
      { name: "caja_ciclo_caja" },
      { name: "caja_consultar_saldo" },
      { name: "caja_registrar_movimiento" },
      { name: "query_sales" },
    ],
  },
  {
    pack: "Clientes & Proveedores",
    subtitle: "CRM y gestión de proveedores",
    tools: [
      { name: "find_customer" },
      { name: "upsert_customer" },
      { name: "delete_customer" },
      { name: "list_contact_leads" },
      { name: "list_suppliers" },
      { name: "create_supplier" },
      { name: "edit_supplier" },
      { name: "delete_supplier" },
      { name: "create_purchase_request" },
    ],
  },
  {
    pack: "Logística",
    subtitle: "Envíos con Andreani y PedidosYa",
    tools: [
      { name: "quote_shipping" },
      { name: "create_shipment" },
      { name: "track_shipment" },
      { name: "get_package_profile" },
      { name: "connect_pedidosya" },
    ],
  },
  {
    pack: "Mensajería WhatsApp",
    subtitle: "Conversación y notificaciones al cliente",
    tools: [
      { name: "connect_whatsapp" },
      { name: "send_whatsapp_text" },
      { name: "send_whatsapp_template" },
    ],
  },
  {
    pack: "Utilidades & Validación",
    subtitle: "CUIT, CUIL, CBU y montos en pesos",
    tools: [
      { name: "validate_cuit" },
      { name: "validate_cuil" },
      { name: "validate_cbu" },
      { name: "format_ars" },
      { name: "parse_ar_amount" },
    ],
  },
  {
    pack: "Conexiones",
    subtitle: "Estado de integraciones del negocio",
    tools: [{ name: "connection_status" }],
  },
  {
    pack: "Widgets interactivos (MCP Apps)",
    subtitle: "10 tools que abren un widget gráfico en el chat",
    tools: [
      { name: "open_catalog_selector" },
      { name: "open_sale_confirm" },
      { name: "open_payment_link_wizard" },
      { name: "open_caja_status" },
      { name: "open_cobro_status" },
      { name: "open_pending_orders" },
      { name: "open_delivery_receipt" },
      { name: "open_onboarding" },
      { name: "open_business_overview" },
      { name: "open_shipment_prep" },
    ],
  },
];

export const TOTAL_TOOLS = TOOL_PACKS.reduce((n, p) => n + p.tools.length, 0);
