// Heurísticas puras para decidir si un input del usuario debe bypasear al
// agente Companion (Gemini Flash) y ir directamente al Supervisor (Gemini Pro).
//
// Vive como módulo separado para que tests puedan importarlo sin levantar
// next-auth, prisma ni la cadena ESM completa de la route.

const CONFIG_KEYWORDS = /\b(regla|reglas|cada\s+\d|siempre|horario|pol[ií]tica|pol[ií]ticas|protocolo|directiva|manda(?:le|n)?\s+a\s+los\s+chicos|acord[áa]te\s+de\s+(?:decirle|recordarle))\b/i;

/**
 * Heurística B2 (Bible §4): bypass directo al supervisor cuando el input
 * upfront se ve "complejo / largo" o contiene palabras-clave de configuración
 * del negocio. Falla en seguro: si dudás, dejá que el companion intente.
 *
 * Triggers:
 * - >240 chars: instrucción multi-paso típica.
 * - "si X entonces Y" / "cuando X hacé Y": condicional explícito.
 * - 3+ "y" como conector: multi-step.
 * - Palabras-clave de configuración (regla, cada, siempre, horario,
 *   política, protocolo, directiva, etc.): el companion no maneja
 *   create/update/delete_business_rule, solo el supervisor.
 */
export function shouldBypassToSupervisor(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 240) return true;
  if (/\bsi\s+\S+.{2,}entonces\b/i.test(trimmed)) return true;
  // El \b final no funciona con "é" (no es word char en regex sin /u),
  // por eso usamos lookahead a separador o fin de string.
  if (/\bcuando\s+\S+.{2,}\bhac[eé](?=\s|$|[.,;!?])/i.test(trimmed)) return true;
  if (CONFIG_KEYWORDS.test(trimmed)) return true;
  const yCount = (trimmed.match(/\s+y\s+/g) ?? []).length;
  if (yCount >= 3) return true;
  return false;
}

/**
 * Heurística B1: escalación post-tier-3 cuando el companion devolvió
 * clarification por segunda vuelta consecutiva. Mira el historial: si el
 * último reply del assistant ya fue una pregunta de clarificación y el
 * companion VUELVE a pedir clarificación, hay que escalar al supervisor.
 */
export function isB1Escalation(
  recentHistory: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): boolean {
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const entry = recentHistory[i];
    if (entry.role === "assistant") {
      const text = entry.text.toLowerCase();
      if (
        text.includes("¿") ||
        text.includes("quisiste decir") ||
        text.includes("cuál") ||
        text.includes("¿qué producto") ||
        text.includes("¿de qué")
      ) {
        return true;
      }
      return false;
    }
  }
  return false;
}
