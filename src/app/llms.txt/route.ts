// src/app/llms.txt/route.ts — Host-aware /llms.txt endpoint.
//
// Standard: llmstxt.org (Jeremy Howard, Sept 2024). Required structure:
//   - H1 (site/project name) — only mandatory element
//   - Blockquote summary
//   - Optional prose + H2 sections with Markdown link lists
//
// Host routing:
//   tools.somosvelora.com/llms.txt → tools toolkit description (MCP server)
//   somosvelora.com/llms.txt       → landing description (agentic commerce platform)
//   www.somosvelora.com/llms.txt   → same as somosvelora.com
//
// The middleware matcher does NOT include /llms.txt, so this handler receives
// the request with the original Host header intact.

import { NextRequest, NextResponse } from "next/server";

// Landing-domain llms.txt — describes Velora as an agentic commerce platform.
// Standard: llmstxt.org. Served for somosvelora.com and www.somosvelora.com.
const LANDING_LLMS_TXT = `# Velora

> Agentic commerce platform — end-to-end. An AI agent sells, charges, invoices
> and ships autonomously, coordinating agent-to-agent (A2A) across fiscal,
> payment, logistics, and messaging systems. MCP toolkit (48 tools) available
> at https://tools.somosvelora.com/api/mcp.

## Platform

- [Velora](https://somosvelora.com) — main platform (chat-first, AI-native)
- [Velora MCP Toolkit](https://tools.somosvelora.com) — 48-tool MCP server for AI agents
- [MCP server llms.txt](https://tools.somosvelora.com/llms.txt) — full tool listing

## Capabilities

Velora automates the complete commerce loop without human intervention:

- End-to-end agentic commerce: sell → charge → invoice → ship, fully autonomous
- Payments: MercadoPago payment links, QR codes, and payment status tracking
- Fiscal (ARCA): electronic invoice and credit/debit note issuance via ARCA SOAP (Argentina)
- Logistics: shipping quotes and shipments via Andreani and OCA couriers; tracking
- Catalog & stock: create/edit/delete products, bulk price updates, stock load and adjustment
- Caja (register): open/close shifts, balance queries, movement registration
- Customers & suppliers: find, create, update; purchase request generation
- WhatsApp, SMS, email: outbound messaging and inbound customer-agent conversations
- Agent-to-agent (A2A): Supervisor coordinates Payments, Fiscal, Logistics, Communications sub-agents
- MCP toolkit: 48 tools across fiscal, payments, logistics, sales, catalog, messaging, caja, customers, suppliers

## Documentation

- [OAuth protected resource](https://tools.somosvelora.com/.well-known/oauth-protected-resource) — auth discovery (RFC 9728)
- [Agent directory](https://somosvelora.com/.well-known/agents.json) — all Velora A2A agent cards
- [Privacy policy](https://somosvelora.com/privacy)
`;

// Source: src/app/tools/_lib/tool-catalog.ts — kept in sync manually.
// Tool descriptions match the MCP tool definitions in src/lib/mcp/*-tools.ts.
// 48 tools across 14 packs (Pure always-on + 12 stateful requiring businessId) + 6 widget tools (open_*).
const TOOLS_LLMS_TXT = `# Velora Toolkit

> Servidor MCP (Model Context Protocol) que expone 48 herramientas de negocio
> argentino — fiscal, pagos, logística, ventas, caja, clientes, proveedores
> y comunicaciones — a cualquier agente de IA.
> Conexión máquina a máquina (stateless Streamable HTTP). Requiere credenciales por tenant.

Para conectarse, apuntá tu cliente MCP al endpoint \`https://tools.somosvelora.com/api/mcp\`.

## Conexión

Claude Code (y cualquier cliente que soporte headers HTTP) se autentica enviando
\`x-api-key\` (clave de API por tenant) y \`x-business-id\` (identificador del negocio)
en cada request.

Los clientes MCP alojados (Cowork, Claude Desktop, claude.ai) se conectan mediante
OAuth 2.1: el cliente descubre el authorization server en
\`/.well-known/oauth-protected-resource\` (RFC 9728), el usuario autoriza una vez, y el
cliente envía el access token en \`Authorization: Bearer <token>\` en cada request.

## Tools

### Puras (siempre activas, sin autenticación)

- [validate_cuit](https://tools.somosvelora.com): Valida CUIT/CUIL y retorna tipo de persona.

### Fiscal (ARCA)

- [get_fiscal_readiness](https://tools.somosvelora.com): Verifica si el negocio puede emitir facturas reales ante ARCA.
- [emit_invoice](https://tools.somosvelora.com): Emite factura electrónica ante ARCA y retorna CAE.
- [emit_nota](https://tools.somosvelora.com): Emite nota de crédito o débito electrónica ante ARCA.

### Pagos

- [get_payment_intent_status](https://tools.somosvelora.com): Estado de PaymentIntent unificado por ID o nombre de cliente.

### Logística

- [quote_shipping](https://tools.somosvelora.com): Cotiza tarifas de todos los couriers activos del negocio.
- [create_shipment](https://tools.somosvelora.com): Crea envío con el courier elegido y retorna número de seguimiento.
- [track_shipment](https://tools.somosvelora.com): Consulta estado e historial de un envío por tracking number.
- [get_package_profile](https://tools.somosvelora.com): Calcula peso y dimensiones de un paquete desde saleId o productos.

### Catálogo & Stock (lectura)

- [query_catalog](https://tools.somosvelora.com): Lista productos activos del catálogo; filtra por nombre. Incluye stock por producto.
- [query_sales](https://tools.somosvelora.com): Consulta métricas de ventas: ingresos, margen, ranking, por empleado o historial de cliente.

### Catálogo & Stock (escritura)

- [create_product](https://tools.somosvelora.com): Crea un nuevo producto en el catálogo.
- [edit_product](https://tools.somosvelora.com): Edita nombre, precio o stock de un producto existente.
- [delete_product](https://tools.somosvelora.com): Elimina o archiva un producto del catálogo.
- [stock_load](https://tools.somosvelora.com): Registra ingreso de mercadería desde proveedor.
- [adjust_stock](https://tools.somosvelora.com): Ajuste absoluto de inventario (set, race-safe).
- [bulk_price_update](https://tools.somosvelora.com): Actualización masiva de precios por porcentaje, monto fijo o valor exacto.

### Ventas & Caja

- [register_sale](https://tools.somosvelora.com): Registra venta completa con items, cliente y método de pago.
- [register_movement](https://tools.somosvelora.com): Registra movimiento de caja (ingreso, egreso, impuesto, sueldo).
- [return_sale](https://tools.somosvelora.com): Revierte las N ventas más recientes (restaura stock y caja).

### Caja

- [caja_consultar_saldo](https://tools.somosvelora.com): Consulta saldo y estado actual de la caja (turno abierto o último cierre).
- [caja_ciclo_caja](https://tools.somosvelora.com): Abre o cierra un turno de caja con fondo inicial o conteo final.
- [caja_registrar_movimiento](https://tools.somosvelora.com): Registra movimiento de caja: ingreso, gasto, retiro, impuesto o sueldo.

### Clientes

- [find_customer](https://tools.somosvelora.com): Busca clientes por nombre o teléfono (substring, case-insensitive).
- [upsert_customer](https://tools.somosvelora.com): Crea o actualiza un cliente; upsert por teléfono.
- [delete_customer](https://tools.somosvelora.com): Elimina un cliente (bloqueado si tiene historial de ventas).

### Proveedores

- [list_suppliers](https://tools.somosvelora.com): Lista todos los proveedores del negocio; filtra por nombre.
- [create_supplier](https://tools.somosvelora.com): Crea un proveedor; idempotente por nombre.
- [edit_supplier](https://tools.somosvelora.com): Actualiza datos de un proveedor existente.
- [delete_supplier](https://tools.somosvelora.com): Elimina un proveedor con trazabilidad de auditoría.
- [create_purchase_request](https://tools.somosvelora.com): Genera una solicitud de compra a un proveedor.

### Comunicaciones

- [send_whatsapp_text](https://tools.somosvelora.com): Envía mensaje de texto libre por WhatsApp (ventana 24 h).
- [send_whatsapp_template](https://tools.somosvelora.com): Envía plantilla Meta aprobada, sin restricción de ventana.

### Conexiones & Onboarding

- [connection_status](https://tools.somosvelora.com): Retorna el estado de cada integración BYOA (fiscal, pagos, envíos, WhatsApp, SMS, email) con guía para conectar las que faltan.

`;

const CACHE_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  // Static content — cache for 1 hour, revalidate in background.
  "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const host = req.headers.get("host") ?? "";

  if (host === "tools.somosvelora.com") {
    return new NextResponse(TOOLS_LLMS_TXT, { status: 200, headers: CACHE_HEADERS });
  }

  if (host === "somosvelora.com" || host === "www.somosvelora.com") {
    return new NextResponse(LANDING_LLMS_TXT, { status: 200, headers: CACHE_HEADERS });
  }

  // Unknown host — no llms.txt.
  return new NextResponse(null, { status: 404 });
}
