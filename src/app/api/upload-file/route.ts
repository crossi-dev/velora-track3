import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { checkRateLimitUpload } from "@/app/api/_lib/route-helpers";

export const maxDuration = 15;

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROWS = 500;
const PREVIEW_COUNT = 5;

export type ImportType = "products" | "customers";

export interface ImportRow {
  name: string;
  price?: number | null;
  stock?: number | null;
  phone?: string | null;
  email?: string | null;
}

export interface UploadPreviewResponse {
  importType: ImportType;
  count: number;
  rows: ImportRow[];
  previewItems: string[];
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function detectImportType(headers: string[]): ImportType {
  const nh = headers.map(normalizeHeader);
  if (nh.some((h) => ["telefono", "phone", "email", "correo"].includes(h))) return "customers";
  return "products";
}

function mapRow(headers: string[], values: (string | number | null)[]): ImportRow {
  const row: Record<string, string | number | null> = {};
  headers.forEach((h, i) => {
    row[normalizeHeader(h)] = values[i] ?? null;
  });

  const name = String(
    row["nombre"] ?? row["name"] ?? row["producto"] ?? row["product"] ?? row["cliente"] ?? row["customer"] ?? ""
  ).trim();

  const rawPrice = row["precio"] ?? row["price"];
  const price = rawPrice != null && rawPrice !== "" ? Number(rawPrice) : null;

  const rawStock = row["stock"] ?? row["cantidad"] ?? row["quantity"];
  const stock = rawStock != null && rawStock !== "" ? Number(rawStock) : null;

  const phone = String(row["telefono"] ?? row["phone"] ?? "").trim() || null;
  const email = String(row["email"] ?? row["correo"] ?? "").trim() || null;

  return {
    name,
    price: price != null && !isNaN(price) ? price : null,
    stock: stock != null && !isNaN(stock) ? stock : null,
    phone,
    email,
  };
}

async function parseXlsx(buffer: ArrayBuffer): Promise<{ headers: string[]; rows: ImportRow[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error("El archivo no tiene hojas.");

  const rawHeaders: string[] = [];
  ws.getRow(1).eachCell((cell) => rawHeaders.push(String(cell.value ?? "")));

  const rows: ImportRow[] = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const values: (string | number | null)[] = [];
    rawHeaders.forEach((_, i) => {
      const cell = row.getCell(i + 1);
      const v = cell.value;
      values.push(v == null ? null : typeof v === "object" ? String(v) : (v as string | number));
    });
    const mapped = mapRow(rawHeaders, values);
    if (mapped.name) rows.push(mapped);
  });

  return { headers: rawHeaders, rows };
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(field.trim()); field = ""; }
      else { field += ch; }
    }
  }
  result.push(field.trim());
  return result;
}

function parseCsv(text: string): { headers: string[]; rows: ImportRow[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("El archivo CSV está vacío.");
  const headers = splitCsvLine(lines[0]);
  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCsvLine(lines[i]);
    const mapped = mapRow(headers, vals);
    if (mapped.name) rows.push(mapped);
  }
  return { headers, rows };
}

export async function POST(req: NextRequest) {
  // CPU/memory bound: Excel/CSV parsing — upload-scoped limit (10 req/min).
  const rateLimited = checkRateLimitUpload(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ code: "MISSING_FILE", message: "No file was provided." }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ code: "FILE_TOO_LARGE", message: "File exceeds the 2 MB limit." }, { status: 413 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["xlsx", "csv"].includes(ext ?? "")) {
    return NextResponse.json({ code: "INVALID_FILE_TYPE", message: "Only .xlsx or .csv files are accepted." }, { status: 415 });
  }

  let headers: string[];
  let rows: ImportRow[];

  try {
    if (ext === "xlsx") {
      ({ headers, rows } = await parseXlsx(await file.arrayBuffer()));
    } else {
      const text = await file.text();
      ({ headers, rows } = parseCsv(text));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "No se pudo leer el archivo.";
    return NextResponse.json({ code: "FILE_PARSE_FAILED", message: msg }, { status: 422 });
  }

  if (rows.length === 0) {
    return NextResponse.json({ code: "NO_VALID_ROWS", message: "No valid rows found in the file." }, { status: 422 });
  }

  const importType = detectImportType(headers);
  const capped = rows.slice(0, MAX_ROWS);

  const previewItems = capped.slice(0, PREVIEW_COUNT).map((r) => {
    if (importType === "products") {
      const parts = [r.name];
      if (r.price != null) parts.push(`$${r.price}`);
      if (r.stock != null) parts.push(`stock: ${r.stock}`);
      return parts.join(" · ");
    }
    const parts = [r.name];
    if (r.phone) parts.push(r.phone);
    return parts.join(" · ");
  });

  const response: UploadPreviewResponse = {
    importType,
    count: capped.length,
    rows: capped,
    previewItems,
  };

  return NextResponse.json(response);
}
