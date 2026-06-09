// employee-procedures.ts — respuestas de referencia para dudas operativas
// del empleado. El Companion las inyecta en el prompt cuando detecta una
// pregunta operativa que no mapea a un intent directo.
//
// Las respuestas son intencionalmente concisas (2-3 oraciones) para que
// el modelo pueda usarlas como base sin repetirlas textualmente.

import { normalizeForMatching } from "@/lib/normalize";

export interface Procedure {
  /** Claves de búsqueda para el detector de dudas operativas. */
  keywords: string[];
  /** Título breve para logs e inyección de contexto. */
  title: string;
  /** Texto que el Companion usa como referencia para responder. */
  description: string;
}

export const EMPLOYEE_PROCEDURES: Procedure[] = [
  {
    keywords: ["cargar", "registrar", "anotar", "hacer", "venta", "vender", "cobrar"],
    title: "Cómo cargar una venta",
    description:
      "Decile al Companion qué vendiste: producto, cantidad y cliente si lo tenés. " +
      "Ejemplo: 'Vendí 2 yogures a García'. Si el cliente es de paso, el Companion " +
      "lo registra como Consumidor Final automáticamente. No necesitás forma de pago — " +
      "el sistema asume efectivo a menos que especifiques otro medio.",
  },
  {
    keywords: ["consultar", "ver", "cuánto", "stock", "inventario", "quedan", "hay"],
    title: "Cómo consultar stock",
    description:
      "Preguntale al Companion directamente: '¿Cuánto stock hay de [producto]?' " +
      "o 'Mostrame todo el stock'. El Companion lee del catálogo en tiempo real. " +
      "No necesitás buscar en ningún otro lado.",
  },
  {
    keywords: ["crear", "nuevo", "agregar", "cliente", "registrar cliente", "cargar cliente"],
    title: "Cómo crear un cliente nuevo",
    description:
      "Crear clientes lo hace el dueño desde el panel. Si tenés datos de un cliente " +
      "nuevo (nombre, teléfono), anotáselos al Companion y él los pasa al dueño al cierre. " +
      "Para registrar una venta, podés usar el nombre aunque el cliente no esté en el sistema " +
      "— el dueño lo carga después.",
  },
  {
    keywords: ["solicitud", "pedido", "compra", "pedir", "proveedor", "reponer", "ordenar"],
    title: "Cómo crear una solicitud de compra",
    description:
      "Decile al Companion qué hace falta reponer: 'Necesitamos más [producto]'. " +
      "El Companion lo anota como solicitud para el dueño. Los pedidos a proveedores " +
      "los gestiona el dueño directamente.",
  },
  {
    keywords: ["llegó", "llegaron", "proveedor", "vino", "entrega", "mercadería", "qué hago"],
    title: "Qué hacer si llega un proveedor",
    description:
      "Anotá lo que entregó: 'Me llegaron [cantidad] [producto]'. El Companion lo " +
      "registra como ingreso de stock y le avisa al Supervisor. Si el proveedor trae " +
      "factura o remito, guardalo y avisale al dueño al cierre.",
  },
  {
    keywords: ["cliente", "enojado", "reclamo", "queja", "molesto", "problema", "insiste"],
    title: "Qué hacer si hay un cliente molesto",
    description:
      "Escuchá al cliente con calma. Si puede resolverse en el momento (información, " +
      "precio, stock), hacelo. Si pide algo que no podés autorizar (descuento, devolución), " +
      "decile: 'Lo voy a anotar para que te llame el encargado hoy.' Luego anotáselo al " +
      "Companion con los detalles.",
  },
  {
    keywords: ["internet", "wifi", "conexión", "sin señal", "offline", "no carga", "no funciona"],
    title: "Qué hacer si se cae internet",
    description:
      "La app tiene modo offline activo: podés seguir registrando ventas y stock. " +
      "Los datos se sincronizan automáticamente cuando vuelve la conexión. " +
      "No cierres la app ni recargues la página — se pierde la cola de operaciones pendientes.",
  },
  {
    keywords: ["cierre", "cerrar", "fin de turno", "fin del día", "terminar", "caja", "conteo"],
    title: "Qué hacer al cierre del día",
    description:
      "Al cierre: (1) registrá las últimas ventas del turno, (2) si hay notas del día " +
      "(incidentes, reclamos, faltantes), anotáselas al Companion para que las pase al dueño. " +
      "(3) Si el dueño pide conteo de caja, hacelo con él directamente — la caja la maneja " +
      "el dueño desde su panel.",
  },
];

/**
 * Devuelve los procedimientos relevantes para una pregunta operativa dada.
 * Usa keyword match simple. Devuelve hasta 3 procedimientos.
 */
export function findRelevantProcedures(userText: string): Procedure[] {
  const normalized = normalizeForMatching(userText);

  const scored: { proc: Procedure; score: number }[] = EMPLOYEE_PROCEDURES.map((proc) => {
    const hits = proc.keywords.filter((kw) => normalized.includes(kw)).length;
    return { proc, score: hits };
  }).filter(({ score }) => score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(({ proc }) => proc);
}

/**
 * Serializa los procedimientos relevantes como texto para inyectar en el prompt.
 */
export function formatProceduresForPrompt(procedures: Procedure[]): string {
  if (procedures.length === 0) return "";
  return procedures
    .map((p) => `- **${p.title}**: ${p.description}`)
    .join("\n");
}
