// Endpoint público que devuelve la VAPID public key. Usado por
// usePushSubscriptionPrompt para suscribirse a web push.
//
// Por qué no usar NEXT_PUBLIC_VAPID_PUBLIC_KEY: es build-time
// (statically replaced) y Cloud Run --source deploy no expone runtime
// env vars al build container. Con este endpoint, la key viaja como
// runtime config y rotar key = setear env + restart, sin rebuild.
//
// La key ES pública (el VAPID public key se transmite al browser para
// que el push service la verifique). No hay tema de seguridad.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return NextResponse.json({ error: "vapid-not-configured" }, { status: 503 });
  }
  // H2: no-store so that a rotated VAPID key is always read fresh from the
  // runtime env — a cached stale key would cause subscribe() to fail until
  // the CDN/browser cache expires.
  return NextResponse.json(
    { publicKey },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
  );
}
