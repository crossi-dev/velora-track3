import { normalizeForMatching } from "@/lib/normalize";

// Distribuidora Mendoza — mock wholesale catalog.
//
// 15 productos típicos del mayorista argentino con precios en ARS (mayo 2026).
// Usados por quote-skill para responder "¿cuánto sale X?"

export interface CatalogItem {
  name: string;
  keywords: string[]; // fragments para fuzzy match
  unitPrice: number;  // ARS sin IVA por unidad
  unit: string;       // "caja", "unidad", "saco", etc.
  qtyPerUnit: number; // unidades por envase de venta mayorista
  deliveryDays: number;
}

export const CATALOG: CatalogItem[] = [
  {
    name: "Cerveza Quilmes Retornable 1L",
    keywords: ["quilmes", "cerveza", "1l", "retornable"],
    unitPrice: 1_850,
    unit: "caja",
    qtyPerUnit: 12,
    deliveryDays: 2,
  },
  {
    name: "Cerveza Brahma 355ml",
    keywords: ["brahma", "cerveza", "355"],
    unitPrice: 780,
    unit: "caja",
    qtyPerUnit: 24,
    deliveryDays: 2,
  },
  {
    name: "Fernet Branca 750ml",
    keywords: ["fernet", "branca", "750"],
    unitPrice: 4_200,
    unit: "caja",
    qtyPerUnit: 12,
    deliveryDays: 3,
  },
  {
    name: "Coca-Cola 2.25L",
    keywords: ["coca", "cola", "2.25", "gaseosa"],
    unitPrice: 1_450,
    unit: "paquete",
    qtyPerUnit: 8,
    deliveryDays: 1,
  },
  {
    name: "Sprite 2.25L",
    keywords: ["sprite", "7up", "gaseosa"],
    unitPrice: 1_380,
    unit: "paquete",
    qtyPerUnit: 8,
    deliveryDays: 1,
  },
  {
    name: "Agua Mineral Villavicencio 500ml",
    keywords: ["agua", "villavicencio", "mineral"],
    unitPrice: 320,
    unit: "pack",
    qtyPerUnit: 24,
    deliveryDays: 1,
  },
  {
    name: "Alfajor Havanna",
    keywords: ["alfajor", "havanna"],
    unitPrice: 1_200,
    unit: "caja",
    qtyPerUnit: 12,
    deliveryDays: 3,
  },
  {
    name: "Alfajor Terrabusi Triple",
    keywords: ["alfajor", "terrabusi", "triple"],
    unitPrice: 580,
    unit: "caja",
    qtyPerUnit: 24,
    deliveryDays: 2,
  },
  {
    name: "Harina Cañuelas Tipo 000 1kg",
    keywords: ["harina", "cañuelas", "000"],
    unitPrice: 640,
    unit: "saco",
    qtyPerUnit: 25,
    deliveryDays: 2,
  },
  {
    name: "Aceite Natura 900ml",
    keywords: ["aceite", "natura", "girasol"],
    unitPrice: 2_100,
    unit: "caja",
    qtyPerUnit: 12,
    deliveryDays: 2,
  },
  {
    name: "Yerba Mate Rosamonte 500g",
    keywords: ["yerba", "rosamonte", "mate"],
    unitPrice: 1_380,
    unit: "caja",
    qtyPerUnit: 20,
    deliveryDays: 2,
  },
  {
    name: "Arroz Gallo 1kg",
    keywords: ["arroz", "gallo"],
    unitPrice: 720,
    unit: "caja",
    qtyPerUnit: 20,
    deliveryDays: 2,
  },
  {
    name: "Fideos Matarazzo 500g",
    keywords: ["fideos", "matarazzo", "pasta"],
    unitPrice: 390,
    unit: "caja",
    qtyPerUnit: 24,
    deliveryDays: 2,
  },
  {
    name: "Azúcar Ledesma 1kg",
    keywords: ["azucar", "azúcar", "ledesma"],
    unitPrice: 950,
    unit: "caja",
    qtyPerUnit: 20,
    deliveryDays: 2,
  },
  {
    name: "Sal La Niña 500g",
    keywords: ["sal", "niña"],
    unitPrice: 280,
    unit: "caja",
    qtyPerUnit: 24,
    deliveryDays: 2,
  },
];

/**
 * Find a catalog item by fuzzy keyword match against the product name.
 * Returns the best matching item or null.
 */
export function findCatalogItem(query: string): CatalogItem | null {
  const q = normalizeForMatching(query);

  let bestMatch: CatalogItem | null = null;
  let bestScore = 0;

  for (const item of CATALOG) {
    let score = 0;
    for (const kw of item.keywords) {
      if (q.includes(normalizeForMatching(kw))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}
