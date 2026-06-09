import ExcelJS from "exceljs";
import { normalizeNullableInput } from "../../../../lib/normalize";

export { normalizeNullableInput };

export function colIndex(headers: string[], ...aliases: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().trim().replace(/\s+/g, ""));
  for (const alias of aliases) {
    const idx = lower.indexOf(alias.toLowerCase().replace(/\s+/g, ""));
    if (idx !== -1) return idx;
  }
  return -1;
}

export function cellStr(row: unknown[], idx: number): string {
  if (idx === -1 || row[idx] === undefined || row[idx] === null) return "";
  return String(row[idx]).trim();
}

export function parseImportNonNegativeNumber(value: unknown): number | null {
  if (value === undefined || value === null) return 0;

  const raw = String(value).trim();
  if (!raw) return 0;

  let normalized = raw.replace(/\s+/g, "").replace(/[$€£¥]/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function parseImportNonNegativeInteger(value: unknown): number | null {
  const parsed = parseImportNonNegativeNumber(value);
  return parsed === null ? null : Math.floor(parsed);
}

function parseCsvBuffer(buffer: Buffer): { headers: string[]; dataRows: unknown[][] } {
  const text = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.split(/[,;]/).map((c) => c.trim().replace(/^"|"$/g, "")));
  const nonEmpty = lines.filter((r) => r.some((c) => c !== ""));
  if (nonEmpty.length < 2) return { headers: [], dataRows: [] };
  const headers = nonEmpty[0].map((h) => String(h ?? ""));
  const dataRows = nonEmpty.slice(1) as unknown[][];
  return { headers, dataRows };
}

export async function parseWorkbook(
  buffer: Buffer,
  fileName?: string,
): Promise<{ headers: string[]; dataRows: unknown[][] } | null> {
  const ext = fileName?.split(".").pop()?.toLowerCase();

  if (ext === "csv") {
    return parseCsvBuffer(buffer);
  }

  const workbook = new ExcelJS.Workbook();
  // @types/node ≥22 makes Buffer generic (Buffer<ArrayBufferLike>); exceljs
  // types still declare the legacy non-generic Buffer. Same runtime object.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return null;

  const rows: unknown[][] = [];
  worksheet.eachRow((row) => {
    // row.values[0] is always null/undefined in exceljs (1-indexed); strip it
    rows.push((row.values as unknown[]).slice(1));
  });

  if (rows.length < 2) return { headers: [], dataRows: [] };

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? ""));
  const dataRows = rows
    .slice(1)
    .filter((row) =>
      (row as unknown[]).some((cell) => cell !== "" && cell !== null && cell !== undefined),
    ) as unknown[][];

  return { headers, dataRows };
}
