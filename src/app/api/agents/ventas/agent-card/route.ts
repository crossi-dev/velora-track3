import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Ventas Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/ventas/agent-card.
// No auth required (public metadata). Cached 5 minutes at the CDN/proxy
// layer so repeated discovery calls do not hit the runtime.
//
// baseUrl is pinned to the canonical custom domain via A2A_PUBLIC_BASE_URL.
// Set that env var in staging/preview to avoid advertising the .run.app URL.
//
// v1.0: card is signed with EdDSA (JWS Compact) for MITM protection.
// v0.3.x clients that ignore the `signature` field remain compatible.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Ventas Agent",
    description:
      "Velora Ventas Agent — catálogo, ventas, stock, caja, clientes, proveedores. " +
      "Decodes Rioplatense Argentine Spanish directives and emits structured intents " +
      "for the Velora operations pipeline.",
    url: `${baseUrl}/api/agents/ventas/jsonrpc`,
    version: "1.0.0",
    provider: {
      organization: "Velora",
      url: "https://somosvelora.com",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "ventas.sale.register",
        name: "Register Sale",
        description: "Records a sale with optional customer, payment method, and line items.",
        examples: [
          "vendé 2 botellas de aceite a Juan",
          "venta efectivo 5000 pesos a María García",
        ],
      },
      {
        id: "ventas.catalog.edit",
        name: "Edit Catalog",
        description: "Creates, updates, or bulk-price-edits products in the catalog.",
        examples: [
          "subí 10% el precio de las papas",
          "agregá producto Yerba Mate 500g a $1200",
        ],
      },
      {
        id: "ventas.stock.adjust",
        name: "Adjust Stock",
        description: "Adjusts inventory levels or loads stock for a product.",
        examples: [
          "cargá 50 unidades de harina",
          "bajá el stock de vasos a 20",
        ],
      },
      {
        id: "ventas.cash.register",
        name: "Register Cash Movement",
        description: "Records a cash-in or cash-out movement in the daily register.",
        examples: [
          "retiro de caja 3000",
          "ingreso extra 1500 pesos",
        ],
      },
      // ── Skills added 2026-05-28: A2A Protocol v1.0 §3 requires the skills
      // array to enumerate ALL agent capabilities for peer discovery.
      // Source: https://a2a-protocol.org/latest/specification/
      {
        id: "ventas.sale.return",
        name: "Return Sale",
        description: "Undoes the N most recent sales (reversal / devolution).",
        tags: ["sales", "return", "undo"],
        examples: [
          "deshacer la última venta",
          "cancelar las 2 ventas anteriores",
        ],
      },
      {
        id: "ventas.catalog.create",
        name: "Create Product",
        description: "Adds a new product to the catalog with name, price, and optional initial stock.",
        tags: ["catalog", "product", "create"],
        examples: [
          "agregá producto Yerba Mate 500g a $1200",
          "nuevo producto Aceite Girasol 1L precio 950",
        ],
      },
      {
        id: "ventas.catalog.delete",
        name: "Delete Product",
        description: "Removes an existing product from the catalog.",
        tags: ["catalog", "product", "delete"],
        examples: [
          "eliminá el producto Aceite Oliva",
          "borrá Yerba Mate del catálogo",
        ],
      },
      {
        id: "ventas.stock.load",
        name: "Load Stock",
        description: "Records inbound stock from a supplier (purchase or restock).",
        tags: ["stock", "restock", "supplier"],
        examples: [
          "entró mercadería: 100 bolsas de harina de La Serenísima",
          "cargá 50 unidades de aceite de Molinos",
        ],
      },
      {
        id: "ventas.customer.create",
        name: "Create Customer",
        description: "Adds a new customer with optional phone, email, and tax ID.",
        tags: ["customer", "create"],
        examples: [
          "nuevo cliente Ana Gómez, cel 2614001122",
          "crear cliente Juan Pérez CUIT 20123456789",
        ],
      },
      {
        id: "ventas.customer.update",
        name: "Update Customer",
        description: "Edits a single field (name, phone, email, taxId, address, postalCode) of an existing customer.",
        tags: ["customer", "update", "edit"],
        examples: [
          "cambiá el teléfono de Ana Gómez a 2614009988",
          "actualizar email de Juan Pérez a juan@mail.com",
        ],
      },
      {
        id: "ventas.supplier.create",
        name: "Create Supplier",
        description: "Adds a new supplier (upserts if the name already exists).",
        tags: ["supplier", "create"],
        examples: [
          "nuevo proveedor Distribuidora Norte, contacto Pedro",
          "crear proveedor Molinos Río de la Plata",
        ],
      },
      {
        id: "ventas.supplier.update",
        name: "Update Supplier",
        description: "Edits a single field (name, phone, email, contactName) of an existing supplier.",
        tags: ["supplier", "update", "edit"],
        examples: [
          "actualizá el teléfono de Distribuidora Norte",
          "cambiar contacto de Molinos a María López",
        ],
      },
      {
        id: "ventas.supplier.delete",
        name: "Delete Supplier",
        description: "Removes an existing supplier.",
        tags: ["supplier", "delete"],
        examples: [
          "eliminar proveedor Distribuidora Norte",
          "borrá a Molinos de los proveedores",
        ],
      },
      {
        id: "ventas.purchase.request.create",
        name: "Create Purchase Request",
        description: "Creates a purchase request to a supplier (procurement / reorder).",
        tags: ["purchase", "procurement", "supplier"],
        examples: [
          "pedile 200 bolsas de harina a Molinos",
          "hacer pedido a Distribuidora Norte de 50 aceites",
        ],
      },
    ],
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        name: "X-API-Key",
        in: "header",
      },
    },
    security: [{ ApiKeyAuth: [] }],
    "x-agentIdentity": {
      kid: "velora-ventas-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/ventas/jwks`,
    },
  };

  const signed = signAgentCard(card, "ventas");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
