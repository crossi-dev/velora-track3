// OAuthState helpers — token único de un solo uso para validar el callback
// OAuth de Mercado Pago. Vive 30 minutos. Se crea en /connect, se consume
// en /callback (consume-once vía DELETE atómico).

import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

const STATE_TTL_MS = 30 * 60 * 1000; // 30 min

export async function createOAuthState(businessId: string): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await prisma.oAuthState.create({
    data: { state, businessId, expiresAt },
  });
  return state;
}

// Valida y consume el state. Devuelve el businessId si es válido y no
// expiró. null en cualquier otro caso. Idempotent: el segundo intento
// con el mismo state devuelve null porque ya fue borrado.
//
// Un solo DELETE atómico elimina la TOCTOU que existía con findUnique +
// deleteMany separados: en multi-instancia (Cloud Run horizontal) dos
// workers concurrentes podían leer found antes de que cualquiera
// ejecutara el delete. El RETURNING sólo llega al ganador.
export async function consumeOAuthState(
  state: string,
): Promise<{ businessId: string } | null> {
  if (!state) return null;
  const rows = await prisma.$queryRaw<Array<{ businessId: string }>>`
    DELETE FROM "OAuthState"
    WHERE state = ${state} AND "expiresAt" > NOW()
    RETURNING "businessId"
  `;
  if (rows.length === 0) return null;
  return { businessId: rows[0].businessId };
}

export async function pruneExpiredOAuthStates(): Promise<number> {
  const result = await prisma.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
