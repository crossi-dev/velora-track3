// Subtype-aware task instruction renderers for employee onboarding.
// Extracted from employee-onboarding.ts to keep that file under 300 lines.

import type { OnboardingTask } from "./employee-onboarding";

export interface TaskExampleArgs {
  exampleProduct: string;
  examplePrice: number;
}

export type TaskRenderer = (args: TaskExampleArgs) => string;

// Subtipos retail concretos relevantes al target market de Velora —
// boutique (ropa), hardware (ferretería), mini-market (almacén/grocery).
// Fallback: "retail" genérico para cualquier otro retail físico, "services"
// para negocios sin stock material.
export type BusinessSubtype = "services" | "boutique" | "hardware" | "mini_market" | "retail";

export function detectBusinessSubtype(rawType: string | undefined): BusinessSubtype {
  if (!rawType) return "retail";
  const t = rawType.toLowerCase();
  if (t === "services" || /(servicio|service)/.test(t)) return "services";
  if (/(boutique|ropa|cloth|indument|moda)/.test(t)) return "boutique";
  if (t === "hardware" || /(ferret|hardware|herramient|materiales)/.test(t)) return "hardware";
  if (/(mini[\s-]?market|almac[eé]n|grocery|kiosc|despensa|food)/.test(t)) return "mini_market";
  return "retail";
}

// Shared renderers — identical across subtypes.
const qrChargeRenderer: TaskRenderer = ({ examplePrice }) =>
  `Cobrá por QR:\n"cobro ${examplePrice}"`;

const saleSendRenderer: TaskRenderer = () =>
  `Mandá el comprobante por WhatsApp:\n"mandalo por WhatsApp"`;

export const SUBTYPE_TASK_RENDERERS: Record<BusinessSubtype, Record<OnboardingTask, TaskRenderer>> = {
  services: {
    first_sale: ({ exampleProduct, examplePrice }) =>
      `Registrá una venta:\n"vendí ${exampleProduct} a ${examplePrice}"`,
    first_stock_query: ({ exampleProduct }) =>
      `Consultá el inventario:\n"qué tengo de ${exampleProduct}"`,
    first_cobro_qr: qrChargeRenderer,
    first_sale_send: saleSendRenderer,
    first_stock_load: ({ exampleProduct }) =>
      `Avisá cuando llegue mercadería:\n"llegaron 10 ${exampleProduct}"`,
    first_sales_query: ({ exampleProduct }) =>
      `Consultá el precio de algo:\n"a cuánto está el ${exampleProduct}"`,
  },
  boutique: {
    first_sale: ({ exampleProduct, examplePrice }) =>
      `Registrá una venta:\n"vendí un ${exampleProduct} a ${examplePrice}"`,
    first_stock_query: ({ exampleProduct }) =>
      `Consultá el inventario:\n"qué tengo de ${exampleProduct}"`,
    first_cobro_qr: qrChargeRenderer,
    first_sale_send: saleSendRenderer,
    first_stock_load: ({ exampleProduct, examplePrice }) =>
      `Avisá cuando llegue mercadería:\n"entraron 20 ${exampleProduct} a ${Math.round(examplePrice * 0.6)}"`,
    first_sales_query: ({ exampleProduct }) =>
      `Consultá el precio de algo:\n"a cuánto está el ${exampleProduct}"`,
  },
  hardware: {
    first_sale: ({ exampleProduct, examplePrice }) =>
      `Registrá una venta:\n"vendí 5 ${exampleProduct} a ${examplePrice}"`,
    first_stock_query: ({ exampleProduct }) =>
      `Consultá el inventario:\n"cuántos ${exampleProduct} tengo"`,
    first_cobro_qr: qrChargeRenderer,
    first_sale_send: saleSendRenderer,
    first_stock_load: ({ exampleProduct, examplePrice }) =>
      `Avisá cuando llegue mercadería:\n"entraron 30 ${exampleProduct} a ${Math.round(examplePrice * 0.6)}"`,
    first_sales_query: ({ exampleProduct }) =>
      `Consultá el precio de algo:\n"a cuánto está el ${exampleProduct}"`,
  },
  mini_market: {
    first_sale: ({ exampleProduct, examplePrice }) =>
      `Registrá una venta:\n"vendí 2 ${exampleProduct} a ${examplePrice}"`,
    first_stock_query: ({ exampleProduct }) =>
      `Consultá el inventario:\n"cuántas ${exampleProduct} me quedan"`,
    first_cobro_qr: qrChargeRenderer,
    first_sale_send: saleSendRenderer,
    first_stock_load: ({ exampleProduct, examplePrice }) =>
      `Avisá cuando llegue mercadería:\n"entraron 24 ${exampleProduct} a ${Math.round(examplePrice * 0.6)}"`,
    first_sales_query: ({ exampleProduct }) =>
      `Consultá el precio de algo:\n"a cuánto está el ${exampleProduct}"`,
  },
  retail: {
    first_sale: ({ exampleProduct, examplePrice }) =>
      `Registrá una venta:\n"vendí 3 ${exampleProduct} a ${examplePrice}"`,
    first_stock_query: ({ exampleProduct }) =>
      `Consultá el inventario:\n"qué tengo de ${exampleProduct}"`,
    first_cobro_qr: qrChargeRenderer,
    first_sale_send: saleSendRenderer,
    first_stock_load: ({ exampleProduct, examplePrice }) =>
      `Avisá cuando llegue mercadería:\n"cargá 50 ${exampleProduct} a ${Math.round(examplePrice * 0.6)}"`,
    first_sales_query: ({ exampleProduct }) =>
      `Consultá el precio de algo:\n"a cuánto está el ${exampleProduct}"`,
  },
};

export function celebrationFor(task: OnboardingTask): string {
  switch (task) {
    case "first_sale":
      return "Primera venta registrada. Quedó en el historial.";
    case "first_stock_query":
      return "Listo. Así consultás el inventario cuando necesitás.";
    case "first_cobro_qr":
      return "QR generado. Así cobrás desde el chat, sin abrir ninguna otra app.";
    case "first_sale_send":
      return "Comprobante enviado. El cliente lo recibe por WhatsApp al toque.";
    case "first_stock_load":
      return "Listo. Así se carga mercadería nueva.";
    case "first_sales_query":
      return "Listo. Así consultás precios y stock de un vistazo.";
  }
}
