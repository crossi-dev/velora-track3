// Seeder del Turno 1 del onboarding conversacional.
// Texto exacto debe coincidir con onboarding-agent.prompt.ts (canonical).
// Si el dueño nuevo abre el chat sin haber escrito nada, el GET inserta este
// mensaje sintético para que la conversación arranque sin pedirle al usuario
// que tipee primero. T1 welcome — explica qué es Velora antes de pedir el
// primer dato. UX decision: este copy literal 2026-05-20.

import { prisma } from "@/lib/prisma";
import { logRouteError } from "@/app/api/_lib/route-helpers";

// Welcome message shown once when a new owner opens the chat without a businessName.
// The ownerName placeholder is replaced at seed time when available via OAuth.
// If no name is available, the message starts with "Hola." (no name).
// Format (3-line value prop + 60s framing + direct input request):
//   Hola [nombre].
//   Soy Velora — el chat que opera tu negocio entero.
//   Cargás ventas, stock, clientes, facturas y envíos sin salir de acá.
//   En 60 segundos arrancamos. ¿Cómo se llama tu negocio?
// No chips — direct free-text input with autoFocus.
// Idle nudge at 45s is client-side (see AssistantHistory.tsx T1_IDLE_NUDGE_MS).
export function buildOnboardingTurn1Text(ownerName: string | null): string {
  const greeting = ownerName ? `Hola ${ownerName}.` : "Hola.";
  return [
    greeting,
    "Soy Velora — el chat que opera tu negocio entero.",
    "Cargás ventas, stock, clientes, facturas y envíos sin salir de acá.",
    "En 60 segundos arrancamos. ¿Cómo se llama tu negocio?",
  ].join("\n");
}

// Chips removed from T1 (design decision 2026-05-25): direct free-text input,
// no "Sí, arrancamos" / "Contame más" chips. The idle 45s nudge surfaces the
// explainer chip client-side only when the owner hasn't responded.
// Prisma's `chips` field is Json — undefined omits the column entirely.
const ONBOARDING_TURN_1_CHIPS = undefined;

export async function maybeSeedOnboardingTurn1(
  businessId: string,
  actorIsOwner: boolean,
  actorUserId?: string | null,
): Promise<{ id: string; text: string; createdAt: Date } | null> {
  // Solo el dueño dispara el seed: el empleado no debería ver Turno 1 nunca.
  if (!actorIsOwner) return null;
  const [business, ownerUser] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true },
    }),
    actorUserId
      ? prisma.user.findUnique({ where: { id: actorUserId }, select: { name: true } })
      : null,
  ]);
  // Negocio "fresh" = name vacío (placeholder creado en createUser). Si ya hay
  // nombre, el onboarding avanzó y no hace falta seed.
  if (!business || (business.name?.trim().length ?? 0) > 0) return null;

  // Extract first name from OAuth name ("Carlos Rossi" → "Carlos").
  const rawName = ownerUser?.name ?? null;
  const firstName = rawName ? rawName.split(" ")[0].trim() || null : null;
  const welcomeText = buildOnboardingTurn1Text(firstName);

  const clientMessageId = `onboarding-turn-1:${businessId}`;
  const createdAt = new Date();
  try {
    // upsert con clientMessageId estable garantiza idempotencia: si el dueño
    // abre el chat dos veces antes de responder, no duplicamos el saludo.
    const seeded = await prisma.chatMessage.upsert({
      where: {
        businessId_clientMessageId: { businessId, clientMessageId },
      },
      // If message already exists (owner reopened chat) keep it as-is.
      update: {},
      create: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "assistant",
        visibility: "public",
        text: welcomeText,
        chips: ONBOARDING_TURN_1_CHIPS,
        createdAt,
      },
      select: { clientMessageId: true, text: true, createdAt: true },
    });
    return { id: seeded.clientMessageId, text: seeded.text, createdAt: seeded.createdAt };
  } catch (err) {
    // Best-effort: si el seed falla, devolvemos null y dejamos que la siguiente
    // request lo intente. Mejor un chat vacío que un 500.
    logRouteError("chat-history:GET:seed-onboarding", err, { businessId });
    return null;
  }
}
