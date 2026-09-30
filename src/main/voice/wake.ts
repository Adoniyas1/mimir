import { existsSync } from "node:fs";
import path from "node:path";
import { getPicovoiceKey, loadVoiceConfig } from "./config.js";

/**
 * Wake-word detection via Picovoice Porcupine, entirely on-device. This is
 * an optional dependency (see package.json `optionalDependencies`) because
 * it ships native prebuilds per-platform and shouldn't block installing or
 * running the rest of the app if it's missing or fails to build.
 *
 * Requires two things the user must provide (documented in README.md):
 *   1. A free Picovoice AccessKey (console.picovoice.ai), stored via Settings.
 *   2. A custom "Mimir" keyword file (.ppn), trained in the same console,
 *      placed at resources/wake-word/mimir_<platform>.ppn.
 *
 * Without either, `startWakeWordListener` resolves to `null` and the app
 * falls back to push-to-talk — a real degraded mode, not a crash.
 */
export interface WakeWordHandle {
  stop: () => void;
}

export async function startWakeWordListener(
  resourcesDir: string,
  onWake: () => void
): Promise<WakeWordHandle | null> {
  const config = await loadVoiceConfig();
  const { hasPicovoiceKey, wakeWordPath } = config;
  const accessKey = hasPicovoiceKey ? await getPicovoiceKey() : null;
  if (!accessKey) {
    console.info("[mimir] No Picovoice key configured — wake word disabled, use push-to-talk.");
    return null;
  }

  const keywordPath = resolveKeywordPath(resourcesDir, wakeWordPath);
  if (!keywordPath) {
    console.warn(
      "[mimir] No Mimir wake-word file found for this platform — wake word disabled, use push-to-talk. " +
        "See README.md for how to train one at console.picovoice.ai."
    );
    return null;
  }

  let PorcupineModule: typeof import("@picovoice/porcupine-node");
  let PvRecorderModule: typeof import("@picovoice/pvrecorder-node");
  try {
    PorcupineModule = await import("@picovoice/porcupine-node");
    PvRecorderModule = await import("@picovoice/pvrecorder-node");
  } catch (err) {
    console.warn(
      "[mimir] Porcupine/PvRecorder native module unavailable on this platform — wake word disabled.",
      err instanceof Error ? err.message : err
    );
    return null;
  }

  const porcupine = new PorcupineModule.Porcupine(accessKey, [keywordPath], [0.5]);
  const recorder = new PvRecorderModule.PvRecorder(porcupine.frameLength, -1);
  recorder.start();

  let stopped = false;
  void (async () => {
    while (!stopped) {
      const frame = await recorder.read();
      const keywordIndex = porcupine.process(frame);
      if (keywordIndex >= 0) onWake();
    }
  })();

  return {
    stop: () => {
      stopped = true;
      try {
        recorder.stop();
        recorder.release();
        porcupine.release();
      } catch {
        // best-effort cleanup
      }
    }
  };
}

function resolveKeywordPath(resourcesDir: string, configuredPath: string | null): string | null {
  if (configuredPath && existsSync(configuredPath)) return configuredPath;
  const platformFile =
    process.platform === "darwin"
      ? "mimir_mac.ppn"
      : process.platform === "win32"
        ? "mimir_windows.ppn"
        : "mimir_linux.ppn";
  const full = path.join(resourcesDir, "wake-word", platformFile);
  return existsSync(full) ? full : null;
}
