"use client";

import { normalizeLookupText } from "../helpers";

export function isClearChatCommand(text: string) {
  const normalized = normalizeLookupText(text).replace(/[.!?,;:]+$/g, "");
  return /^(borra(?:r)?|limpia(?:r)?|vacia(?:r)?|reinicia(?:r)?|resetea(?:r)?)(\s+todo)?(\s+el)?\s+chat$/.test(normalized);
}

export function getParsedSaleCommand(text: string): "confirm" | "confirm_whatsapp" | "edit" | null {
  const normalized = normalizeLookupText(text).replace(/[.!?,;:]+$/g, "").trim();
  if (!normalized) return null;

  const confirmWhatsappCommands = [
    "confirma y manda la factura por whatsapp",
    "confirmar y mandar la factura por whatsapp",
    "confirma y envia la factura por whatsapp",
    "confirmar y enviar la factura por whatsapp",
    "confirma y abri whatsapp",
    "confirmar y abrir whatsapp",
    "manda la factura por whatsapp",
    "manda factura por whatsapp",
    "envia la factura por whatsapp",
    "enviar la factura por whatsapp",
    "abrir factura por whatsapp",
    "abrir whatsapp",
    "si mandala por whatsapp",
    "si envia la factura por whatsapp",
    "dale mandala por whatsapp",
    "dale envia la factura por whatsapp",
  ];

  if (confirmWhatsappCommands.some((command) => normalized === command)) {
    return "confirm_whatsapp";
  }

  const confirmCommands = [
    "confirma",
    "confirmar",
    "confirma la venta",
    "confirmar la venta",
    "confirmar venta",
    "confirma venta",
    "confirma",
    "guardar venta",
    "guarda la venta",
    "guarda venta",
    "guardar la venta",
    "finaliza la venta",
    "finalizar la venta",
    "cerra la venta",
    "cerrar la venta",
    "emitir factura",
    "emiti factura",
    "emiti factura",
    "si",
    "dale",
    "ok",
    "okay",
    "listo",
    "de una",
    "perfecto",
    "confirmado",
  ];

  if (confirmCommands.some((command) => normalized === command)) {
    return "confirm";
  }

  const editCommands = [
    "no",
    "editar",
    "editar venta",
    "editar la venta",
    "corregir",
    "corregila",
    "corregir venta",
    "cambiar",
    "cambiar venta",
    "cambiar la venta",
    "modificar",
    "modificar venta",
    "ajustar",
    "ajustar venta",
  ];

  return editCommands.some((command) => normalized === command) ? "edit" : null;
}
