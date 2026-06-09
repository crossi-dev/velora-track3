import mammoth from "mammoth";
import { GoogleGenAI, Type } from "@google/genai";
import { GeminiModels } from "@/lib/gemini-models";

export interface DocumentPage {
  text: string;
  page: number;
}

export async function parseDocumentPages(buffer: ArrayBuffer, filename: string): Promise<DocumentPage[]> {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext === "pdf") return parsePdfPages(buffer);
  if (ext === "docx") return parseDocxAsOnePage(buffer);

  throw new Error("Solo se aceptan archivos PDF o Word (.docx).");
}

// ── Gemini client (same region/auth pattern as extract-rules.ts) ──────────────

function getAiParser(): GoogleGenAI {
  const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "my-gcp-project";
  const location =
    process.env.VERTEX_LOCATION_RULE_EXTRACT ??
    process.env.VERTEX_LOCATION_SUPERVISOR ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    "us-south1";
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true, project: PROJECT_ID, location };
  if (credentialsJson) {
    opts.googleAuthOptions = { credentials: JSON.parse(credentialsJson) as Record<string, unknown> };
  }
  return new GoogleGenAI(opts);
}

// ── Vertex AI JSON response schema for page-level extraction ──────────────────

const PAGE_EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  required: ["pages"],
  properties: {
    pages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["page", "text"],
        properties: {
          page: { type: Type.INTEGER },
          text: { type: Type.STRING },
        },
      },
    },
  },
};

const PAGE_EXTRACTION_PROMPT =
  "Extract the full text content of this PDF, broken down by page number. " +
  "Return every page that contains readable text. Preserve paragraphs, lists, and headings as plain text. " +
  "Do not summarize — include the complete text of each page.";

/**
 * Sends the PDF as a Gemini multimodal inlineData part and asks it to return
 * the full text per page. Uses the same region + auth pattern as extract-rules.ts
 * (VERTEX_LOCATION_RULE_EXTRACT / VERTEX_LOCATION_SUPERVISOR, defaults us-south1).
 *
 * Source: https://ai.google.dev/gemini-api/docs/document-processing
 * Verified: inlineData with mimeType "application/pdf" is the canonical approach
 * for files already in memory (no GCS upload required, limit: 50 MB / 1000 pages).
 * The route enforces a 10 MB cap before this path is reached, so we are well within limits.
 */
async function parsePdfPages(buffer: ArrayBuffer): Promise<DocumentPage[]> {
  const ai = getAiParser();
  const base64 = Buffer.from(buffer).toString("base64");

  const res = await ai.models.generateContent({
    model: GeminiModels.RULE_EXTRACT,
    contents: [
      {
        role: "user",
        parts: [
          { text: PAGE_EXTRACTION_PROMPT },
          { inlineData: { mimeType: "application/pdf", data: base64 } },
        ],
      },
    ],
    config: {
      temperature: 0,
      maxOutputTokens: 32000,
      responseMimeType: "application/json",
      responseSchema: PAGE_EXTRACTION_SCHEMA as never,
    } as never,
  });

  const rawText = (res.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();

  let parsed: unknown;
  try {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("El PDF no contiene texto extraíble o no pudo procesarse.");
  }

  const result = parsed as { pages?: Array<{ page: number; text: string }> };
  const pages: DocumentPage[] = (result.pages ?? [])
    .filter((p) => typeof p.text === "string" && p.text.trim().length > 0)
    .map((p) => ({ page: p.page, text: p.text.trim() }));

  if (pages.length === 0) {
    throw new Error("El PDF no contiene texto extraíble. ¿Es un PDF escaneado sin OCR?");
  }

  return pages;
}

async function parseDocxAsOnePage(buffer: ArrayBuffer): Promise<DocumentPage[]> {
  const nodeBuffer = Buffer.from(buffer);
  const result = await mammoth.extractRawText({ buffer: nodeBuffer });
  const text = result.value.trim();
  if (!text) throw new Error("El documento Word está vacío.");
  return [{ text, page: 1 }];
}
