import { NextResponse } from "next/server";

export type ImportType = "products" | "customers" | "suppliers";

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_DATA_ROWS = 500;

const ALLOWED_EXTENSIONS = /\.(xlsx|xls|csv)$/i;

/**
 * Validates the multipart form fields for an import request.
 * Returns either the parsed fields or a NextResponse error to short-circuit.
 */
export function validateImportForm(formData: FormData):
  | { ok: true; file: Blob; fileName: string; type: ImportType }
  | { ok: false; response: NextResponse } {
  const file = formData.get("file");
  const type = formData.get("type") as ImportType | null;

  if (!file || !(file instanceof Blob)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Falta adjuntar un archivo." }, { status: 400 }),
    };
  }
  if (!type || !["products", "customers", "suppliers"].includes(type)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "El tipo de importación es inválido." }, { status: 400 }),
    };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "El archivo supera el límite de 5 MB." },
        { status: 413 }
      ),
    };
  }

  const fileName = file instanceof File ? file.name : "";
  if (fileName && !ALLOWED_EXTENSIONS.test(fileName)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Solo se aceptan archivos Excel (.xlsx, .xls) o CSV (.csv)." },
        { status: 400 }
      ),
    };
  }

  return { ok: true, file, fileName, type };
}

/**
 * Translates IMPORT_INVALID_PRICE / IMPORT_INVALID_STOCK thrown inside the
 * transaction loop into the user-facing 400 response. Returns null when the
 * error is not one of the recognized sentinels.
 */
export function formatRowValidationError(error: unknown): NextResponse | null {
  if (!(error instanceof Error)) return null;

  if (error.message.startsWith("IMPORT_INVALID_PRICE:")) {
    const rowNumber = error.message.split(":")[1] ?? "?";
    return NextResponse.json(
      { error: `La fila ${rowNumber} tiene un precio inválido. Usá un número mayor o igual a cero.` },
      { status: 400 }
    );
  }

  if (error.message.startsWith("IMPORT_INVALID_STOCK:")) {
    const rowNumber = error.message.split(":")[1] ?? "?";
    return NextResponse.json(
      { error: `La fila ${rowNumber} tiene un stock inválido. Usá un número mayor o igual a cero.` },
      { status: 400 }
    );
  }

  return null;
}
