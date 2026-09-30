/**
 * Local, offline speech-to-text using Whisper via transformers.js. Runs
 * entirely in the renderer over WASM (or WebGPU when available) — no
 * native compilation, no cloud STT key, and it works identically on
 * macOS and Windows because it's pure web platform + WASM.
 *
 * The model is downloaded on first use and cached by the browser's Cache
 * Storage, so subsequent transcriptions are offline and fast to start.
 */

import { watchForSilence, type AutoStopOptions, type AutoStopReason } from "./vad.js";

type Pipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string }>;

let transcriberPromise: Promise<Pipeline> | null = null;

async function getTranscriber(): Promise<Pipeline> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const p = await pipeline("automatic-speech-recognition", "onnx-community/whisper-tiny.en", {
        // Mimir disables Electron GPU acceleration for reliable window
        // painting, so probing WebGPU only produces a failed-adapter warning.
        // Whisper's compact q8 WASM path is predictable on an 8 GB M1.
        dtype: "q8",
        device: "wasm"
      });
      return p as unknown as Pipeline;
    })();
  }
  return transcriberPromise;
}

/** Warm the model in the background so the first real transcription is fast. */
export function preloadTranscriber(): void {
  void getTranscriber().catch((err) => console.warn("[mimir] STT preload failed:", err));
}

/**
 * Records from the default microphone until `stop()` is called, then
 * returns the transcribed text. Whisper wants 16kHz mono Float32 PCM —
 * we capture whatever the mic gives us and resample with an
 * OfflineAudioContext.
 */
export class VoiceRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
  }

  /** Stop watching the mic and call `onStop` once the room goes quiet —
   * see voice/vad.ts. Must be called after `start()`. */
  watchForAutoStop(onStop: (reason: AutoStopReason) => void, opts?: AutoStopOptions): () => void {
    if (!this.stream) throw new Error("Recorder was never started.");
    return watchForSilence(this.stream, onStop, opts);
  }

  /** Stops recording and returns the transcribed text — or "" if Whisper
   * hallucinated a non-speech tag from near-silence (see isHallucination). */
  async stopAndTranscribe(): Promise<string> {
    const blob = await this.stopAndGetBlob();
    const samples = await decodeTo16kMono(blob);
    return transcribeSamples(samples);
  }

  /** Stops recording and releases the mic without transcribing — for when
   * VAD decided nothing was actually said. */
  abort(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
  }

  private stopAndGetBlob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error("Recorder was never started."));
        return;
      }
      this.mediaRecorder.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: this.mediaRecorder?.mimeType }));
      };
      this.mediaRecorder.stop();
    });
  }
}

/** Transcribes 16 kHz mono samples produced directly by the Open Mic VAD. */
export async function transcribeSamples(samples: Float32Array): Promise<string> {
  const transcriber = await getTranscriber();
  const result = await transcriber(samples);
  const text = result.text.trim();
  return isHallucination(text) ? "" : text;
}

/**
 * Whisper tends to invent a bracketed/parenthesized non-speech tag —
 * "[BLANK_AUDIO]", "(silence)", "[Music]", "[inaudible]", etc. — when fed
 * near-silent audio instead of just returning empty text. Our RMS-based
 * VAD (voice/vad.ts) is an approximation and can occasionally trigger on
 * background noise, so this is a real path, not a theoretical one. Only
 * matches when the ENTIRE trimmed output is one such tag — real speech
 * essentially never transcribes to exactly that shape, so this shouldn't
 * catch genuine short replies like "hi" or "yes".
 */
function isHallucination(text: string): boolean {
  if (!text) return true;
  return /^[([][^()[\]]{1,40}[)\]][.!?]?$/.test(text);
}

async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
