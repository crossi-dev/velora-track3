import { type NextRequest } from "next/server";
import { type ZodSchema, type z } from "zod";
import { badRequest } from "./route-helpers";
import { cloudLog } from "@/lib/cloud-logger";

type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: ReturnType<typeof badRequest> };

export async function parseZodBody<S extends ZodSchema>(
  req: NextRequest,
  schema: S,
): Promise<ParsedBody<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ZOD_BODY_INVALID_JSON",
      a2a_transfer: false,
      message: "Request body is not valid JSON.",
      data: { endpoint: req.nextUrl?.pathname ?? "unknown" },
    });
    return { ok: false, response: badRequest("El cuerpo de la solicitud no es JSON válido.") };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.errors[0];
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "ZOD_BODY_VALIDATION_FAILED",
      a2a_transfer: false,
      message: first ? `${first.path.join(".")}: ${first.message}` : "Body validation failed.",
      data: {
        endpoint: req.nextUrl?.pathname ?? "unknown",
        path: first?.path.join(".") ?? "(unknown)",
        code: first?.code ?? "(unknown)",
        issues: result.error.errors.length,
      },
    });
    return {
      ok: false,
      response: badRequest(
        first ? `${first.path.join(".")}: ${first.message}` : "El cuerpo de la solicitud no es válido.",
      ),
    };
  }
  return { ok: true, data: result.data };
}
