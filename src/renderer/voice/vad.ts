/**
 * A lightweight energy-based (RMS) voice-activity detector — deliberately
 * NOT a full ML model. A proper Silero/ONNX VAD (e.g. @ricky0123/vad-web)
 * needs its own WASM + model-asset pipeline (self-hosted files, base-path
 * config) that would be one more thing to get silently wrong with no way
 * to hear the result in development; this is a well-understood, dependency
 * -free technique that reliably delivers the thing that actually matters —
 * stop recording when the room goes quiet, instead of waiting out a fixed
 * timeout — without a new fragile asset-loading subsystem.
 */

export type AutoStopReason = "silence-after-speech" | "no-speech-timeout" | "max-duration" | "cancelled";

export interface AutoStopOptions {
  /** RMS level (0–1) above which a frame counts as "speech". */
  speechThreshold?: number;
  /** Short initial sampling period used to measure ambient microphone noise. */
  calibrationMs?: number;
  /** How long a continuous run of silence *after* speech was heard ends the recording. */
  silenceMs?: number;
  /** Give up if no speech is ever detected within this long. */
  noSpeechTimeoutMs?: number;
  /** Hard safety cap regardless of VAD state, in case something never triggers. */
  maxDurationMs?: number;
}

const DEFAULTS: Required<AutoStopOptions> = {
  speechThreshold: 0.02,
  calibrationMs: 400,
  silenceMs: 1300,
  noSpeechTimeoutMs: 6000,
  maxDurationMs: 20_000
};

/**
 * Watches `stream`'s audio energy and calls `onStop` once, with a reason,
 * when it decides recording should end. Returns a cancel function — call
 * it to stop watching early (e.g. the user manually ended the recording
 * first); `onStop` still fires, with reason "cancelled", so callers can
 * use a single code path instead of branching on how it ended.
 */
export function watchForSilence(
  stream: MediaStream,
  onStop: (reason: AutoStopReason) => void,
  opts: AutoStopOptions = {}
): () => void {
  const cfg = { ...DEFAULTS, ...opts };
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const data = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let hasSpoken = false;
  let lastSpeechAt = startedAt;
  let ambientTotal = 0;
  let ambientFrames = 0;
  let noiseFloor = 0;
  let stopped = false;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    for (const sample of data) sumSquares += sample * sample;
    const rms = Math.sqrt(sumSquares / data.length);
    const now = Date.now();

    // A fixed threshold makes a quiet room work but can treat a fan, laptop
    // speaker, or nearby conversation as endless speech. Use an average,
    // rather than a single calibration peak, then let the floor adapt slowly
    // only while the frame is quiet. A short transient therefore cannot make
    // Mimir listen forever, and a changing room remains usable.
    if (now - startedAt < cfg.calibrationMs) {
      ambientTotal += rms;
      ambientFrames++;
      return;
    }
    if (ambientFrames > 0 && noiseFloor === 0) noiseFloor = ambientTotal / ambientFrames;
    const speechThreshold = Math.max(cfg.speechThreshold, noiseFloor * 3);

    if (rms > speechThreshold) {
      hasSpoken = true;
      lastSpeechAt = now;
    } else {
      noiseFloor = noiseFloor === 0 ? rms : noiseFloor * 0.95 + rms * 0.05;
    }

    if (now - startedAt > cfg.maxDurationMs) {
      finish("max-duration");
    } else if (!hasSpoken && now - startedAt > cfg.noSpeechTimeoutMs) {
      finish("no-speech-timeout");
    } else if (hasSpoken && now - lastSpeechAt > cfg.silenceMs) {
      finish("silence-after-speech");
    }
  }, 100);

  function finish(reason: AutoStopReason): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    source.disconnect();
    void audioContext.close();
    onStop(reason);
  }

  return () => finish("cancelled");
}
