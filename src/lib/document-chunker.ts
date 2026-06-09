import "server-only";

export interface DocumentChunk {
  text: string;
  chunkIndex: number;
  sourcePage: number;
}

const CHUNK_SIZE = 1400;  // ~350 tokens (4 chars/token average, Spanish)
const OVERLAP = 320;      // ~80 tokens overlap

export function chunkPageTexts(pages: Array<{ text: string; page: number }>): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let globalIndex = 0;
  for (const { text, page } of pages) {
    const pageChunks = slidingWindowChunks(text, page, globalIndex);
    globalIndex += pageChunks.length;
    chunks.push(...pageChunks);
  }
  return chunks;
}

function slidingWindowChunks(text: string, page: number, startIndex: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let pos = 0;
  let localIndex = 0;

  while (pos < text.length) {
    const rawEnd = Math.min(pos + CHUNK_SIZE, text.length);
    const chunkEnd = snapToParagraphBoundary(text, rawEnd);
    const chunk = text.slice(pos, chunkEnd).trim();

    if (chunk.length >= 50) {
      chunks.push({ text: chunk, chunkIndex: startIndex + localIndex, sourcePage: page });
      localIndex++;
    }

    if (chunkEnd >= text.length) break;
    pos = Math.max(pos + 1, chunkEnd - OVERLAP);
  }

  return chunks;
}

function snapToParagraphBoundary(text: string, near: number): number {
  if (near >= text.length) return text.length;
  const searchFrom = Math.max(0, near - 200);
  const idx = text.indexOf("\n\n", searchFrom);
  if (idx !== -1 && idx <= near + 400) return idx + 2;
  return near;
}
