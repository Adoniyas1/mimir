/**
 * Local, offline sentence embeddings via transformers.js — same "heavy WASM
 * dependency lives in the renderer, loaded lazily on first real use"
 * pattern as Whisper STT (voice/stt.ts). Xenova/all-MiniLM-L6-v2 is a small
 * (~90MB fp32, much smaller quantized) general-purpose embedding model,
 * downloaded once and cached by the browser like every other model here.
 */

type EmbedPipeline = (
  texts: string[],
  opts?: Record<string, unknown>
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<EmbedPipeline> | null = null;

async function getExtractor(): Promise<EmbedPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const p = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "q8",
        device: "wasm"
      });
      return p as unknown as EmbedPipeline;
    })();
  }
  return extractorPromise;
}

/** Returns L2-normalized embeddings (mean-pooled), one per input string, in
 * the same order — normalized so a plain dot product is cosine similarity. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  return output.tolist();
}
