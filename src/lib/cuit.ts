/**
 * Argentine CUIT/CUIL utilities — extracted from @ar-agents/identity to avoid
 * pulling in the Vercel `ai` SDK peer dependency which is not used in this project.
 * Logic is identical to @ar-agents/identity v0.5.x parseCuit / describePersonType.
 */

const PREFIX_TO_TYPE: Record<string, string> = {
  "20": "fisica_masculina",
  "21": "fisica",          // AFIP CUIL assignments for some natural persons
  "22": "fisica",          // AFIP CUIL assignments for some natural persons
  "27": "fisica_femenina",
  "23": "fisica_extranjera",
  "24": "fisica_extranjera",
  "30": "juridica",
  "33": "juridica_alternativa",
  "34": "juridica_alternativa",
};

const CHECK_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

function computeCheckDigit(first10: string): number | null {
  if (first10.length !== 10 || !/^\d{10}$/.test(first10)) return null;
  const sum = CHECK_WEIGHTS.reduce(
    (acc, weight, i) => acc + weight * Number(first10[i]),
    0
  );
  const remainder = sum % 11;
  if (remainder === 0) return 0;
  if (remainder === 1) return 9;
  return 11 - remainder;
}

export interface CuitParseResult {
  valid: boolean;
  normalized: string;
  formatted: string | null;
  prefix: string | null;
  body: string | null;
  checkDigit: string | null;
  personType: string;
  error?: string;
}

export function parseCuit(input: string): CuitParseResult {
  const normalized = (input ?? "").replace(/\D/g, "");

  if (normalized.length === 0) {
    return { valid: false, normalized, formatted: null, prefix: null, body: null, checkDigit: null, personType: "desconocida", error: "CUIT vacío." };
  }
  if (normalized.length !== 11) {
    return { valid: false, normalized, formatted: null, prefix: null, body: null, checkDigit: null, personType: "desconocida", error: `Debe tener 11 dígitos; recibí ${normalized.length}.` };
  }

  const prefix = normalized.slice(0, 2);
  const body = normalized.slice(2, 10);
  const checkDigit = normalized.slice(10);
  const personType = PREFIX_TO_TYPE[prefix] ?? "desconocida";
  const formatted = `${prefix}-${body}-${checkDigit}`;

  if (personType === "desconocida") {
    return { valid: false, normalized, formatted, prefix, body, checkDigit, personType, error: `Prefijo ${prefix} no es válido. Esperado: 20/21/22/23/24/27 (persona física) o 30/33/34 (persona jurídica).` };
  }

  const expected = computeCheckDigit(normalized.slice(0, 10));
  if (expected === null) {
    return { valid: false, normalized, formatted, prefix, body, checkDigit, personType, error: "No se pudo calcular el dígito verificador (input no numérico)." };
  }
  if (Number(checkDigit) !== expected) {
    return { valid: false, normalized, formatted, prefix, body, checkDigit, personType, error: `Dígito verificador inválido. Esperado: ${expected}, recibido: ${checkDigit}. Probablemente hay un typo en el CUIT.` };
  }

  return { valid: true, normalized, formatted, prefix, body, checkDigit, personType };
}

export function describePersonType(type: string): string {
  switch (type) {
    case "fisica_masculina": return "Persona física (masculino).";
    case "fisica_femenina": return "Persona física (femenino).";
    case "fisica_extranjera": return "Persona física (extranjero o caso especial).";
    case "fisica": return "Persona física (CUIL prefijo 21/22).";
    case "juridica": return "Persona jurídica.";
    case "juridica_alternativa": return "Persona jurídica (prefijo alternativo).";
    default: return "Tipo de persona desconocido.";
  }
}
