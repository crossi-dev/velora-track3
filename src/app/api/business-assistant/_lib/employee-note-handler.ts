// employee-note-handler.ts — persiste notas del empleado para revisión del dueño al cierre.
//
// Llamado por preFilterStage cuando el Companion detecta una narración no operativa
// (>15 chars sin verbos de venta/stock) en modo franquicia estricto.
// Las notas se listan en el panel "Notas del equipo" del dashboard del dueño.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import type { CloudLogComponent } from "@/lib/cloud-logger";

const NOTE_COMPONENT: CloudLogComponent = "Employee";

export interface SaveNoteInput {
  businessId: string;
  employeeId: string;
  content: string;
}

/** Persiste una EmployeeNote. Lanza si falla — llamar dentro de bg() para no bloquear. */
export async function saveEmployeeNote(input: SaveNoteInput): Promise<void> {
  const { businessId, employeeId, content } = input;

  await prisma.employeeNote.create({
    data: { businessId, employeeId, content: content.slice(0, 1000) },
  });

  cloudLog({
    severity: "INFO",
    component: NOTE_COMPONENT,
    action: "EMPLOYEE_NOTE_SAVED",
    a2a_transfer: false,
    message: "employee note saved for owner review",
    businessId,
    actorEmployeeId: employeeId,
    data: { contentLength: content.length },
  });
}

export interface EmployeeNoteRow {
  id: string;
  businessId: string;
  employeeId: string;
  employeeName: string;
  content: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

/** Lista notas pendientes (sin acknowledgedAt) para el panel del dueño. */
export async function listPendingNotes(businessId: string): Promise<EmployeeNoteRow[]> {
  const rows = await prisma.employeeNote.findMany({
    where: { businessId, acknowledgedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { employee: { select: { name: true } } },
  });

  return rows.map((r: typeof rows[number]) => ({
    id: r.id,
    businessId: r.businessId,
    employeeId: r.employeeId,
    employeeName: r.employee.name,
    content: r.content,
    createdAt: r.createdAt,
    acknowledgedAt: r.acknowledgedAt,
  }));
}

/** Marca una nota como leída por el dueño. */
export async function acknowledgeNote(noteId: string, businessId: string): Promise<void> {
  await prisma.employeeNote.updateMany({
    where: { id: noteId, businessId },
    data: { acknowledgedAt: new Date() },
  });
}
