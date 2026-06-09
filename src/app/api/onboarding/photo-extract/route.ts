// POST /api/onboarding/photo-extract — Turn 5 del onboarding del owner.
// El dueño manda una foto de su cuaderno o de las etiquetas; Gemini Pro
// Vision extrae nombre/precio/stock y el cliente arma una card de
// confirmación. Sin DB writes acá: el confirm dispara /api/products POST.

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimitUpload, logRouteError } from "@/app/api/_lib/route-helpers";
import { checkAiPerMinuteLimit, checkAiRateLimit } from "@/app/api/_lib/ai-rate-limit";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { extractProductsFromImage } from "./_lib/extract-products-from-image";

export const maxDuration = 40;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);

export async function POST(req: NextRequest) {
  // Gemini Vision call + 8MB image buffer — upload-scoped limit (10 req/min).
  const rateLimited = checkRateLimitUpload(req);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Necesitás iniciar sesión." }, { status: 401 });
  }
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  if (!(await checkAiPerMinuteLimit(actor.actorUserId))) {
    return NextResponse.json({ code: "RATE_LIMITED", message: "Probá de nuevo en un momento." }, { status: 429 });
  }
  const aiAllowed = await checkAiRateLimit(actor.actorUserId);
  if (!aiAllowed) {
    return NextResponse.json({ code: "DAILY_LIMIT_REACHED", message: "Llegaste al límite diario. Probá mañana." }, { status: 429 });
  }

  if (!actor.businessId) {
    return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "No encontramos tu negocio." }, { status: 404 });
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ code: "MISSING_FILE", message: "Falta la foto." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ code: "FILE_TOO_LARGE", message: "La foto pesa más de 8 MB. Probá con una más liviana." }, { status: 413 });
  }
  const mime = (file.type || "").toLowerCase();
  if (!ACCEPTED_MIME.has(mime)) {
    return NextResponse.json({ code: "INVALID_FILE_TYPE", message: "Solo aceptamos imágenes (JPG, PNG, WEBP)." }, { status: 415 });
  }

  try {
    const buffer = await file.arrayBuffer();
    const result = await extractProductsFromImage(buffer, mime);
    return NextResponse.json({ products: result.products });
  } catch (err) {
    logRouteError("/api/onboarding/photo-extract", err);
    return NextResponse.json({ code: "EXTRACT_FAILED", message: "No pude leer la foto. Probá con una imagen más nítida." }, { status: 500 });
  }
}
