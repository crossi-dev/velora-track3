// Detecta posibles intents operativos que el modelo clasificó como "answer".
// Loguea POSSIBLE_MISSED_INTENT en Cloud Logging para posterior debugging.
// No reintenta ni modifica el flujo — sólo observabilidad.

import { cloudLog } from "@/lib/cloud-logger";
import { redactInput } from "@/lib/redact-pii";

const PATTERNS: Array<{ intent: string; re: RegExp }> = [
  { intent: "register_sale",    re: /vend[íi]|cobr[éea]|vendimos|hice una venta|factur[éea]/i },
  { intent: "stock_load",       re: /lleg[óoa]ron|me entreg|ingres[óoa]|carg[éa] stock|recib[íi]/i },
  { intent: "create_customer",  re: /nuevo cliente|agrega cliente|guarda el (num|cel|tel|contacto)|anot[áa] el contacto/i },
  { intent: "register_movement",re: /pagu[éea]|gast[éoa]|sueldo|pag[óo] (la|el|los|las)|ret[ií]r[éea]/i },
  { intent: "edit_product",     re: /cambi[áa] (el )?precio|ponele|actualiz[áa].*precio|subi[ó]|baj[ó].*precio/i },
  { intent: "create_purchase_request", re: /ped[íi] al proveedor|hac[éa] un pedido|solicit[áa]/i },
  { intent: "report_event",     re: /se acab[óo]|no queda|roto|incidente|queja/i },
];

export function detectPossibleMissedIntent(text: string): string | null {
  for (const { intent, re } of PATTERNS) {
    if (re.test(text)) return intent;
  }
  return null;
}

export function logIfMissedIntent({
  text,
  modelAnswer,
  confidence,
  businessId,
  actorEmployeeId,
}: {
  text: string;
  modelAnswer: string;
  confidence: number | null | undefined;
  businessId: string;
  actorEmployeeId: string | null;
}): void {
  const suggested = detectPossibleMissedIntent(text);
  if (!suggested) return;
  cloudLog({
    severity: "WARNING",
    component: "Employee",
    action: "POSSIBLE_MISSED_INTENT",
    a2a_transfer: false,
    message: `model returned 'answer' but input pattern suggests '${suggested}'`,
    businessId,
    actorEmployeeId: actorEmployeeId ?? undefined,
    data: {
      inputText: redactInput(text, 200),
      suggestedIntent: suggested,
      modelAnswer: redactInput(modelAnswer, 120),
      confidence: confidence ?? null,
    },
  });
}
