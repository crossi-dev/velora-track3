// src/app/developers/_lib/widget-catalog.ts — The 10 MCP Apps widgets exposed
// by the velora-mcp server. Each widget is backed by a real `open_*` tool
// (see tool-catalog.ts, "Widgets interactivos" pack). Per the MCP Apps spec,
// only one widget renders inline in the chat at a time — never several at once.

export interface WidgetEntry {
  tool: string;
  title: string;
  body: string;
  /**
   * Display-only semantic accent for the /developers showcase — mirrors the
   * real state color the widget itself uses at runtime (see the matching
   * chip in src/lib/mcp/widgets/*.tsx), so the marketing preview isn't
   * arbitrarily colored. Not read by the widget runtime.
   */
  accent: "brand" | "success" | "warning" | "neutral";
  /** Short mono status/label shown on the mini preview card. */
  preview: string;
}

export const WIDGETS: WidgetEntry[] = [
  {
    tool: "open_catalog_selector",
    title: "Selector de catálogo",
    body: "Elegís productos de una grilla visual en vez de escribir nombres a mano.",
    accent: "neutral",
    preview: "3 productos · stock ok",
  },
  {
    tool: "open_sale_confirm",
    title: "Confirmación de venta",
    body: "Revisás el detalle de la venta — items, cliente, método de pago — antes de que se registre.",
    accent: "success",
    preview: "Venta registrada ✓",
  },
  {
    tool: "open_payment_link_wizard",
    title: "Wizard de link de pago",
    body: "Armás un link de cobro de MercadoPago paso a paso, sin salir del chat.",
    accent: "brand",
    preview: "Link de cobro listo",
  },
  {
    tool: "open_caja_status",
    title: "Estado de caja",
    body: "Ves el saldo y el turno de caja abierto en un panel, no como texto suelto.",
    accent: "brand",
    preview: "Turno abierto",
  },
  {
    tool: "open_cobro_status",
    title: "Estado de cobro",
    body: "Seguís si un pago está pendiente, procesando o confirmado, en vivo.",
    accent: "warning",
    preview: "Esperando pago",
  },
  {
    tool: "open_pending_orders",
    title: "Pedidos pendientes",
    body: "Un dashboard con los pedidos que todavía esperan despacho o cobro.",
    accent: "warning",
    preview: "4 pedidos pendientes",
  },
  {
    tool: "open_delivery_receipt",
    title: "Comprobante de entrega",
    body: "El comprobante del envío, listo para compartir con el cliente.",
    accent: "success",
    preview: "Entregado ✓",
  },
  {
    tool: "open_onboarding",
    title: "Onboarding / conexiones",
    body: "Guía para conectar ARCA, MercadoPago, WhatsApp y couriers desde el chat.",
    accent: "neutral",
    preview: "5/7 conectadas",
  },
  {
    tool: "open_shipment_prep",
    title: "Preparar envío",
    body: "Stock disponible y cotización de envío juntos en una sola pantalla, antes de despachar.",
    accent: "brand",
    preview: "Listo para despachar",
  },
  {
    tool: "open_business_overview",
    title: "Resumen del negocio",
    body: "El pantallazo rápido al escribir 'veamos mi negocio': caja, ventas del día, cobros pendientes y stock bajo.",
    accent: "brand",
    preview: "Todo al día",
  },
];
