"use client";

import { normalizeLookupText } from "../helpers";

export function looksLikeFreshTopLevelTask(input: string) {
  const normalized = normalizeLookupText(input);
  if (!normalized) return false;

  const explicitTaskPatterns = [
    /^(?:necesito|quiero|agrega(?:me)?|agregar|crea(?:me)?|crear|carga(?:me)?|cargar|registra(?:me)?|registrar|edita(?:me)?|editar|cambia(?:me)?|cambiar|actualiza(?:me)?|actualizar|busca(?:me)?|buscar|mostra(?:me)?|mostrar|manda(?:me)?|mandar|envia(?:me)?|enviar|descarga(?:me)?|descargar|marca(?:me)?|marcar|abri|abrir|vendi|vender)\b/,
    /\b(?:cliente|proveedor|producto|stock|inventario|venta|factura|solicitud|pedido)\s+(?:nuevo|nueva)\b/,
    /\b(?:el|la|un|una)\s+(?:cliente|proveedor|producto)\s+(?:nuevo|nueva)\b/,
  ];
  if (explicitTaskPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const taskTerms = [
    "cliente",
    "proveedor",
    "producto",
    "stock",
    "inventario",
    "venta",
    "factura",
    "solicitud",
    "pedido",
  ];
  const actionTerms = [
    "agregar",
    "crear",
    "cargar",
    "registrar",
    "editar",
    "cambiar",
    "actualizar",
    "buscar",
    "mostrar",
    "mandar",
    "enviar",
    "descargar",
    "marcar",
    "abrir",
    "vender",
  ];

  return taskTerms.some((term) => normalized.includes(term)) && actionTerms.some((term) => normalized.includes(term));
}

export function shouldContinueAssistantQuestionTurn(
  assistantQuestionContext: string | null,
  baseText: string,
  continueAssistantQuestion: boolean
) {
  if (!assistantQuestionContext) return false;
  if (continueAssistantQuestion) return true;
  return !looksLikeFreshTopLevelTask(baseText);
}
