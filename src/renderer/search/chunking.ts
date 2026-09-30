/** Pure text-chunking and vector-math helpers, kept free of the transformers.js
 * import so they're unit-testable without a WASM runtime. */

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

/** Splits long text into overlapping windows so a match can be pinpointed
 * within a file rather than only at whole-file granularity. Short files
 * come back as a single chunk. */
export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/** Dot product of two equal-length vectors — cosine similarity when both
 * inputs are already L2-normalized, which embedTexts() guarantees. */
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
