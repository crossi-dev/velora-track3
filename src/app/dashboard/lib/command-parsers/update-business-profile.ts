import { tLang } from "../DashboardLangContext";
import type { BusinessProfileField, UpdateBusinessProfileData, VeloraSingleCommand } from "./shared";

export type { BusinessProfileField, UpdateBusinessProfileData };

// Each pattern captures the new value. The field is inferred from the
// matching pattern (position in the array), kept alongside via the
// `fieldForPattern` lookup.
const PATTERNS: Array<{ regex: RegExp; field: BusinessProfileField }> = [
  // name: "cambiá el nombre del negocio a X" / "el nombre del negocio es X"
  {
    regex: /^(?:cambia(?:le|me)?|cambia|cambiar|actualiza(?:le|me)?|actualiza|actualizar|pone(?:le|me)?|pone|poner)\s+(?:el\s+)?nombre\s+del\s+negocio\s+a\s+(.+?)\s*$/,
    field: "name",
  },
  {
    regex: /^(?:el\s+)?nombre\s+del\s+negocio\s+es\s+(.+?)\s*$/,
    field: "name",
  },
  // phone: "el teléfono del negocio es X" / "cambiá el teléfono a X" / "whatsapp X"
  {
    regex: /^(?:cambia(?:le|me)?|cambia|cambiar|actualiza(?:le|me)?|actualiza|actualizar)\s+(?:el\s+)?(?:telefono|tel|whatsapp)\s+(?:del\s+negocio\s+)?a\s+(.+?)\s*$/,
    field: "phone",
  },
  {
    regex: /^(?:el\s+)?(?:telefono|tel|whatsapp)\s+(?:del\s+negocio\s+)?es\s+(.+?)\s*$/,
    field: "phone",
  },
  // address: "la dirección del negocio es X" / "cambiá la dirección a X"
  {
    regex: /^(?:cambia(?:le|me)?|cambia|cambiar|actualiza(?:le|me)?|actualiza|actualizar)\s+(?:la\s+)?direccion\s+(?:del\s+negocio\s+)?a\s+(.+?)\s*$/,
    field: "address",
  },
  {
    regex: /^(?:la\s+)?direccion\s+(?:del\s+negocio\s+)?es\s+(.+?)\s*$/,
    field: "address",
  },
  // email: "el email del negocio es X" / "cambiá el email a X"
  {
    regex: /^(?:cambia(?:le|me)?|cambia|cambiar|actualiza(?:le|me)?|actualiza|actualizar)\s+(?:el\s+)?(?:email|correo|mail)\s+(?:del\s+negocio\s+)?a\s+(.+?)\s*$/,
    field: "email",
  },
  {
    regex: /^(?:el\s+)?(?:email|correo|mail)\s+(?:del\s+negocio\s+)?es\s+(.+?)\s*$/,
    field: "email",
  },
  // taxId: "el CUIT del negocio es X" / "cambiá el CUIT a X"
  {
    regex: /^(?:cambia(?:le|me)?|cambia|cambiar|actualiza(?:le|me)?|actualiza|actualizar)\s+(?:el\s+)?(?:cuit|cuil)\s+(?:del\s+negocio\s+)?a\s+(.+?)\s*$/,
    field: "taxId",
  },
  {
    regex: /^(?:el\s+)?(?:cuit|cuil)\s+(?:del\s+negocio\s+)?es\s+(.+?)\s*$/,
    field: "taxId",
  },
];

export function detectUpdateBusinessProfile(normalized: string): VeloraSingleCommand | null {
  for (const { regex, field } of PATTERNS) {
    const m = normalized.match(regex);
    if (!m) continue;
    const value = m[1].trim();
    if (!value || value.length < 2) continue;
    return {
      matched: true,
      intent: "update_business_profile",
      data: { field, value },
    };
  }
  return null;
}

export function buildUpdateBusinessProfileConfirmMessage(data: UpdateBusinessProfileData): string {
  const label: Record<BusinessProfileField, string> = {
    name: tLang("name", "nombre"),
    phone: tLang("phone", "teléfono"),
    address: tLang("address", "dirección"),
    email: "email",
    taxId: "CUIT",
  };
  return tLang(`Update business ${label[data.field]} to "${data.value}"?`, `¿Actualizar ${label[data.field]} del negocio a "${data.value}"?`);
}
