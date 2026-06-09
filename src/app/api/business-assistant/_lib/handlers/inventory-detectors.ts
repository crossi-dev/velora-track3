import { normalizePositiveIntegerString, normalizeForMatching } from "../shared";
import { looksLikeQuestionStyleRequest } from "./inventory-matching";

// Inventory query detectors removed in the deterministic-layer inversion
// (commit 677abea). Stock/price/inventory queries now go to Gemini Flash;
// business-query.ts post-handler is the safety net for inventory-wide asks.

export function looksLikeEditProductRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const editTerms = [
    "editar",
    "edita",
    "actualizar",
    "actualiza",
    "cambiar",
    "cambia",
    "modificar",
    "modifica",
    "renombrar",
    "poner",
    "subir",
    "subi",
    "subile",
    "aumentar",
    "aumenta",
    "aumentale",
    "bajar",
    "baja",
    "bajale",
    "reducir",
    "reduce",
    "reducile",
  ];
  const productTerms = ["producto", "ítem", "articulo", "artículo"];
  const productFieldTerms = [
    "precio",
    "vale",
    "cuesta",
    "sale a",
    "valor",
    "costo",
    "costo unitario",
    "me cuesta",
    "sku",
    "codigo",
    "código",
    "cod",
  ];
  const renameTerms = ["nombre", "se llama", "llamalo", "llamala"];

  const hasEditVerb = editTerms.some((term) => normalized.includes(term));
  const hasProductReference = productTerms.some((term) => normalized.includes(term));
  const hasProductField = productFieldTerms.some((term) => normalized.includes(term));
  const hasRenameField = renameTerms.some((term) => normalized.includes(term));

  return (hasEditVerb && (hasProductField || hasProductReference || hasRenameField)) || (hasProductReference && hasProductField);
}

export function looksLikeStockAdjustmentRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const procurementTerms = [
    "cargar stock",
    "carga de stock",
    "reponer",
    "repong",
    "comprar",
    "compra",
    "pedido",
    "proveedor",
    "fabricante",
    "precio por unidad",
    "costo unitario",
  ];
  if (procurementTerms.some((term) => normalized.includes(normalizeForMatching(term)))) return false;

  const stockTerms = ["stock", "inventario", "cantidad", "unidades"];
  const productEditFieldTerms = [
    "precio",
    "vale",
    "cuesta",
    "sale a",
    "valor",
    "costo",
    "costo unitario",
    "me cuesta",
    "sku",
    "codigo",
    "código",
    "cod",
    "nombre",
    "se llama",
    "llamalo",
    "llamala",
  ];
  const setTerms = ["dejar", "dejalo", "dejala", "poner", "ponelo", "ponela", "cambiar", "actualizar", "editar", "ajustar"];
  const increaseTerms = ["agregar", "agrega", "agregale", "sumar", "suma", "sumale", "incrementar", "subir", "subi", "subile", "aumentar", "aumenta", "aumentale"];
  const decreaseTerms = ["quitar", "quita", "quitale", "restar", "resta", "restale", "bajar", "baja", "bajale", "disminuir", "disminui", "descontar", "descontale"];

  const hasStockReference = stockTerms.some((term) => normalized.includes(normalizeForMatching(term)));
  const hasProductEditFieldReference = productEditFieldTerms.some((term) => normalized.includes(normalizeForMatching(term)));
  const hasQuantity = Boolean(normalizePositiveIntegerString(text.match(/\b(\d+(?:[.,]\d+)?)\b/)?.[1] ?? ""));
  const hasAdjustmentVerb = [...setTerms, ...increaseTerms, ...decreaseTerms].some((term) =>
    normalized.includes(normalizeForMatching(term))
  );
  const hasPronominalStockVerb = /\b(?:sumale|restale|agregale|quitale|subile|bajale|dejalo|ponelo)\b/i.test(normalized);

  if (!hasAdjustmentVerb || !hasQuantity) return false;
  if (hasProductEditFieldReference && !hasStockReference) return false;

  return hasStockReference || hasPronominalStockVerb;
}

export function looksLikeDeleteProductRequest(text: string) {
  const normalized = normalizeForMatching(text);
  if (looksLikeQuestionStyleRequest(text)) return false;

  const deleteTerms = [
    "eliminar",
    "elimina",
    "eliminá",
    "borrar",
    "borra",
    "borrá",
    "borrame",
    "borrale",
    "quitar",
    "quita",
    "quitá",
    "quitame",
    "quitale",
    "sacar",
    "saca",
    "sacá",
    "sacame",
    "sacale",
    "remover",
    "remové",
    "dar de baja",
    "dar baja",
  ];
  const productTerms = ["producto", "ítem", "item", "articulo", "artículo"];

  const hasDeleteVerb = deleteTerms.some((term) => normalized.includes(normalizeForMatching(term)));
  const hasProductReference = productTerms.some((term) => normalized.includes(normalizeForMatching(term)));

  return hasDeleteVerb && hasProductReference;
}

export function looksLikeStockLoadRequest(text: string) {
  const normalized = normalizeForMatching(text);
  if (looksLikeStockAdjustmentRequest(text)) return false;
  if (looksLikeQuestionStyleRequest(text)) return false;

  const contactCreationTerms = ["cliente", "clientes"];
  if (contactCreationTerms.some((term) => normalized.includes(normalizeForMatching(term)))) return false;

  const strongStockTerms = [
    "ingresar",
    "ingresa",
    "ingresan",
    "ingreso",
    "entrada",
    "entra",
    "entran",
    "cargar",
    "reponer",
    "reposicion",
    "stock",
    "inventario",
    "repongamos",
    "reponemos",
    "reponermos",
  ];
  const reorderPhrases = [
    "hay que pedir",
    "hay q pedir",
    "pidamos stock",
    "pedimos stock",
    "necesitamos mas stock",
    "necesitamos más stock",
  ];
  const itemReferenceTerms = [
    "producto",
    "productos",
    "ítem",
    "articulo",
    "articulos",
    "artículo",
    "artículos",
    "nuevo producto",
    "producto nuevo",
    "nuevo ítem",
    "ítem nuevo",
  ];

  const hasQuantityPattern =
    /\b\d+\s*(?:unidades?|u\b|cajas?|piezas?|items?|kg|lt?)\b/.test(normalized) ||
    /\b\d{2,}\b/.test(normalized) ||
    /\b(?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|cien)\b/.test(normalized);

  const hasStrongStockSignal =
    strongStockTerms.some((term) => normalized.includes(term)) ||
    reorderPhrases.some((term) => normalized.includes(term));
  const hasItemReference = itemReferenceTerms.some((term) => normalized.includes(normalizeForMatching(term)));

  return hasStrongStockSignal && (hasQuantityPattern || hasItemReference);
}
