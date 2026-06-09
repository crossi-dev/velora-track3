// src/app/tools/_lib/tool-catalog.ts — Tool catalog data for the landing page + llms.txt.
//
// Source of truth: src/lib/mcp/server.ts (header comment) + src/lib/mcp/*-tools.ts files.
// 40 tools across 12 packs (Pure is always-on; the rest require a verified businessId).
// Widget tools (open_*) are registered server-side but omitted from this display catalog.
// Extracted to keep src/app/tools/page.tsx under the 300-line file limit.

export interface ToolEntry {
  name: string;
  desc: string;
}

export interface ToolPack {
  /** Display name (Spanish) */
  pack: string;
  /** Subtitle shown below the pack name */
  subtitle: string;
  tools: ToolEntry[];
}

// ── Catalog ───────────────────────────────────────────────────────────────────
// Descriptions mirror the registerTool() description strings in *-tools.ts and
// server.ts. Keep them in sync when adding new tools.

export const TOOL_PACKS: ToolPack[] = [
  {
    pack: "Puras (siempre activas)",
    subtitle: "Sin autenticación requerida",
    tools: [
      { name: "validate_cuit", desc: "Valida CUIT/CUIL y retorna tipo de persona." },
    ],
  },
  {
    pack: "Fiscal (ARCA)",
    subtitle: "Facturación electrónica WSFE",
    tools: [
      { name: "get_fiscal_readiness", desc: "Verifica si el negocio puede emitir facturas reales ante ARCA." },
      { name: "emit_invoice", desc: "Emite factura electrónica ante ARCA y retorna CAE." },
      { name: "emit_nota", desc: "Emite nota de crédito o débito electrónica ante ARCA." },
    ],
  },
  {
    pack: "Pagos",
    subtitle: "MercadoPago y estado de cobros",
    tools: [
      { name: "get_payment_intent_status", desc: "Estado de PaymentIntent unificado por ID o nombre de cliente." },
    ],
  },
  {
    pack: "Logística",
    subtitle: "Envíos y seguimiento (Andreani, OCA)",
    tools: [
      { name: "quote_shipping", desc: "Cotiza tarifas de todos los couriers activos del negocio." },
      { name: "create_shipment", desc: "Crea envío con el courier elegido y retorna número de seguimiento." },
      { name: "track_shipment", desc: "Consulta estado e historial de un envío por tracking number." },
      { name: "get_package_profile", desc: "Calcula peso y dimensiones de un paquete desde saleId o productos." },
    ],
  },
  {
    pack: "Catálogo & Stock (lectura)",
    subtitle: "Consulta de productos y existencias",
    tools: [
      { name: "query_catalog", desc: "Lista productos activos del catálogo; filtra por nombre. Incluye stock por producto." },
      { name: "query_sales", desc: "Consulta métricas de ventas: ingresos, margen, ranking, por empleado o historial de cliente." },
    ],
  },
  {
    pack: "Catálogo & Stock (escritura)",
    subtitle: "Alta, edición y gestión de inventario",
    tools: [
      { name: "create_product", desc: "Crea un nuevo producto en el catálogo." },
      { name: "edit_product", desc: "Edita nombre, precio o stock de un producto existente." },
      { name: "delete_product", desc: "Elimina o archiva un producto del catálogo." },
      { name: "stock_load", desc: "Registra ingreso de mercadería desde proveedor." },
      { name: "adjust_stock", desc: "Ajuste absoluto de inventario (set, race-safe)." },
      { name: "bulk_price_update", desc: "Actualización masiva de precios por porcentaje, monto fijo o valor exacto." },
    ],
  },
  {
    pack: "Ventas & Caja",
    subtitle: "Registro de ventas, movimientos y promesas",
    tools: [
      { name: "register_sale", desc: "Registra venta completa con items, cliente y método de pago." },
      { name: "register_movement", desc: "Registra movimiento de caja (ingreso, egreso, impuesto, sueldo)." },
      { name: "register_promesa_sale", desc: "Registra venta con pago diferido (promesa / cuentas a cobrar)." },
      { name: "confirm_promesa_payment", desc: "Marca un PaymentIntent existente como promesa de pago." },
      { name: "settle_promesa_payment", desc: "Registra el cobro efectivo de una promesa previa." },
      { name: "return_sale", desc: "Revierte las N ventas más recientes (restaura stock y caja)." },
    ],
  },
  {
    pack: "Caja",
    subtitle: "Turno y saldo de caja registradora",
    tools: [
      { name: "caja_consultar_saldo", desc: "Consulta saldo y estado actual de la caja (turno abierto o último cierre)." },
      { name: "caja_ciclo_caja", desc: "Abre o cierra un turno de caja con fondo inicial o conteo final." },
      { name: "caja_registrar_movimiento", desc: "Registra movimiento de caja: ingreso, gasto, retiro, impuesto o sueldo." },
    ],
  },
  {
    pack: "Clientes",
    subtitle: "Búsqueda y gestión de clientes",
    tools: [
      { name: "find_customer", desc: "Busca clientes por nombre o teléfono (substring, case-insensitive)." },
      { name: "upsert_customer", desc: "Crea o actualiza un cliente; upsert por teléfono." },
      { name: "delete_customer", desc: "Elimina un cliente (bloqueado si tiene historial de ventas)." },
    ],
  },
  {
    pack: "Proveedores",
    subtitle: "Alta, edición y órdenes de compra",
    tools: [
      { name: "list_suppliers", desc: "Lista todos los proveedores del negocio; filtra por nombre." },
      { name: "create_supplier", desc: "Crea un proveedor; idempotente por nombre." },
      { name: "edit_supplier", desc: "Actualiza datos de un proveedor existente." },
      { name: "delete_supplier", desc: "Elimina un proveedor con trazabilidad de auditoría." },
      { name: "create_purchase_request", desc: "Genera una solicitud de compra a un proveedor." },
    ],
  },
  {
    pack: "Comunicaciones",
    subtitle: "WhatsApp saliente",
    tools: [
      { name: "send_whatsapp_text", desc: "Envía mensaje de texto libre por WhatsApp (ventana 24 h)." },
      { name: "send_whatsapp_template", desc: "Envía plantilla Meta aprobada, sin restricción de ventana." },
    ],
  },
  {
    pack: "Conexiones & Onboarding",
    subtitle: "Estado de integraciones BYOA",
    tools: [
      { name: "connection_status", desc: "Retorna el estado de cada integración BYOA (fiscal, pagos, envíos, WhatsApp, SMS, email) con guía para conectar las que faltan." },
    ],
  },
];

export const TOTAL_TOOLS = TOOL_PACKS.reduce((n, p) => n + p.tools.length, 0);
// Expected: 38 (2+3+1+4+2+6+6+3+3+5+2+1 — wholesale removed, send_sms/send_email removed, ask_velora removed; widget tools (open_*) counted separately in server.ts)
