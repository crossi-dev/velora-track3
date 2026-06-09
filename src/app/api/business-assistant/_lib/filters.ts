import type { AssistantBusinessPromptContext } from "./types";
import { levenshteinDistance, normalizeForMatching } from "./shared";

export function looksLikeAnalyticsQuery(text: string): boolean {
  const n = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // Always analytics — never operational
  if (/\b(reporte|estadistica|analitica|margen|ganancia)\b/.test(n)) return true;
  if (/\bresumen\b/.test(n)) return true;
  if (/mas\s+vendid/.test(n)) return true;
  if (/mejor\s+(product|client)/.test(n)) return true;
  if (/cuant[ao]s?\s+vend/.test(n)) return true;

  // Time words only trigger analytics when the query is a question
  // "¿cuánto vendí hoy?" → analytics  |  "registrá la venta de hoy" → companion
  const isQuestion = /[?¿]/.test(text) || /^(cuanto|cuanta|cuantos|cuantas|que |como |cual )/.test(n);
  if (isQuestion && /\b(hoy|ayer|semana|mes|ano)\b/.test(n)) return true;

  return false;
}

export function buildModelContext(
  context: AssistantBusinessPromptContext,
  isAnalytics: boolean
): AssistantBusinessPromptContext {
  if (isAnalytics) {
    const { products: _products, ...analyticsContext } = context;
    return analyticsContext;
  }
  const { recentSales: _recentSales, ...slim } = context;
  return slim;
}

export function isBusinessQuery(text: string, contextTerms: string[]) {
  const normalized = normalizeForMatching(text);
  const tokens = normalized.match(/[a-z0-9]+/g) ?? [];

  if (tokens.length >= 6) return true;

  if (/\d/.test(normalized)) return true;

  const businessKeywords = [
    // Sales
    "venta", "ventas", "vendi", "vender", "vendele", "cobrar", "cobrale", "cobro",
    // Stock & inventory
    "stock", "inventario", "carga", "cargar", "reponer", "repone", "unidad", "unidades",
    "cantidad", "ajustar", "ajuste", "descontar", "descuento",
    "llego", "llegaron", "llegaron", "llegan", "vino", "vinieron", "trajo", "trajeron",
    "mercaderia", "ingreso", "ingresar", "ingresa", "metele", "meti",
    // Products
    "producto", "productos", "repuesto", "repuestos", "categoria", "categorias", "marca", "marcas",
    // Contacts
    "cliente", "clientes", "fabricante", "fabricantes", "proveedor", "proveedores",
    // Pricing & money
    "precio", "precios", "valor", "ingreso", "ganancia", "ganancias", "costos", "perdida",
    "deuda", "deudas", "pago", "pagos", "saldo",
    // Documents
    "factura", "facturas", "recibo", "recibos", "presupuesto", "remito", "remitos",
    "nota de credito",
    // Shift / scheduling
    "turno", "empiezo", "arranco", "inicio turno", "empezar",
    // Operations
    "comprar", "compra", "impuesto", "caja", "pedido", "pedidos",
    "entrega", "entregas", "devolucion", "devoluciones",
    // CRUD verbs
    "agregar", "crear", "registrar", "editar", "edita", "modificar", "eliminar",
    "cambia", "cambiar",
    // Analytics & general
    "analitica", "negocio", "operacion", "operaciones",
    "movimiento", "movimientos", "resumen", "total",
    "cuanto", "cuantos", "cuanta", "cuantas",
    // Money slang
    "luca", "lucas", "palo", "mangos",
    // WhatsApp / send triggers
    "wpp", "wsp", "whatsapp", "mandale", "mandalo", "mandame", "envia", "enviale",
    // Contact creation
    "anota", "apunta", "apuntalo", "anotame",
    // Undo / delete
    "saca", "sacalo", "sacame", "anula", "cancela",
    "deshacer", "deshac",
    // Contact fields commonly edited
    "telefono", "teléfono",
  ].map(normalizeForMatching);

  const keywordMatch = businessKeywords.some((keyword) => {
    if (normalized.includes(keyword)) return true;
    return tokens.some((token) => {
      if (token === keyword) return true;
      if (token.length >= 5 && (token.startsWith(keyword) || keyword.startsWith(token))) return true;
      const maxDistance = keyword.length >= 8 ? 2 : keyword.length >= 5 ? 1 : 0;
      return maxDistance > 0 && levenshteinDistance(token, keyword) <= maxDistance;
    });
  });

  const contextMatch = contextTerms.some((term) => {
    const normalizedTerm = normalizeForMatching(term);
    return normalizedTerm.length >= 3 && normalized.includes(normalizedTerm);
  });

  return keywordMatch || contextMatch;
}
