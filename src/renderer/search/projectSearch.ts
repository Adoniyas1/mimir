import { embedTexts } from "./embeddings.js";
import { chunkText, dot } from "./chunking.js";
import type { ProjectFileCorpusEntry, SemanticSearchHit } from "../../shared/types.js";

interface CachedFile {
  mtimeMs: number;
  chunks: { text: string; embedding: number[] }[];
}

const SNIPPET_CHARS = 400;

/** In-memory only — rebuilt from scratch each app session. Keyed by mtimeMs
 * so an edited file is re-embedded but an unchanged one is free on repeat
 * searches. Not persisted to disk; a first pass, honest scope for now. */
const cache = new Map<string, CachedFile>();

/** Embeds and ranks `corpus` against `query`, updating the in-memory cache
 * for any file that's new or has changed since the last call. */
export async function searchProjectFiles(
  query: string,
  corpus: ProjectFileCorpusEntry[],
  topK: number
): Promise<SemanticSearchHit[]> {
  for (const file of corpus) {
    const cached = cache.get(file.path);
    if (cached && cached.mtimeMs === file.mtimeMs) continue;
    const pieces = chunkText(file.content);
    const embeddings = await embedTexts(pieces);
    cache.set(file.path, {
      mtimeMs: file.mtimeMs,
      chunks: pieces.map((text, i) => ({ text, embedding: embeddings[i] ?? [] }))
    });
  }

  // Drop cache entries for files no longer present, so a deleted/renamed
  // file's stale chunks don't keep showing up in results.
  const currentPaths = new Set(corpus.map((f) => f.path));
  for (const cachedPath of cache.keys()) {
    if (!currentPaths.has(cachedPath)) cache.delete(cachedPath);
  }

  const [queryEmbedding] = await embedTexts([query]);
  if (!queryEmbedding) return [];

  const scored: SemanticSearchHit[] = [];
  for (const [filePath, file] of cache) {
    for (const chunk of file.chunks) {
      scored.push({ path: filePath, snippet: chunk.text.slice(0, SNIPPET_CHARS), score: dot(queryEmbedding, chunk.embedding) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
