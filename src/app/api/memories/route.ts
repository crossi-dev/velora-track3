import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import {
  listOwnerMemories,
  deleteOwnerMemory,
  isMemoryBankEnabled,
} from "@/lib/agent-memory-bank";

export const maxDuration = 10;

// GET /api/memories — list owner memories (latest 10 for UI display)
export async function GET(req: NextRequest): Promise<NextResponse> {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  if (!isMemoryBankEnabled()) {
    return NextResponse.json({ memories: [], enabled: false });
  }

  const memories = await listOwnerMemories(ctx.businessId);
  return NextResponse.json({ memories: memories.slice(0, 10), enabled: true });
}

const deleteSingleSchema = z.object({ memoryName: z.string().min(1) }).strict();
const deleteAllSchema = z.object({ deleteAll: z.literal(true) }).strict();

// DELETE /api/memories — delete one { memoryName } or all { deleteAll: true }
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  if (!isMemoryBankEnabled()) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: "BAD_REQUEST", message: "Invalid JSON body." }, { status: 400 });
  }

  // deleteAll path
  const allResult = deleteAllSchema.safeParse(body);
  if (allResult.success) {
    const all = await listOwnerMemories(ctx.businessId);
    await Promise.allSettled(all.map((m) => deleteOwnerMemory(m.name)));
    return NextResponse.json({ ok: true, deleted: all.length });
  }

  // single delete path
  const singleResult = deleteSingleSchema.safeParse(body);
  if (!singleResult.success) {
    const first = singleResult.error.errors[0];
    return NextResponse.json(
      { code: "BAD_REQUEST", message: first ? `${first.path.join(".")}: ${first.message}` : "Invalid body." },
      { status: 400 },
    );
  }

  await deleteOwnerMemory(singleResult.data.memoryName);
  return NextResponse.json({ ok: true, deleted: 1 });
}
