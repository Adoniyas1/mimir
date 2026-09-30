import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ELEVENLABS_VOICE_ID, getElevenLabsKey, loadVoiceConfig } from "./config.js";

export interface SpeakOptions {
  provider: "system" | "elevenlabs";
  voiceId?: string; // ElevenLabs voice id, ignored for system TTS
  systemVoice?: string;
}

/**
 * Speak `text` out loud and resolve once playback finishes. Defaults to the
 * OS's built-in TTS (zero cost, zero keys) — `say` on macOS, the SAPI
 * SpeechSynthesizer via PowerShell on Windows, `spd-say`/`espeak` as a
 * best-effort fallback on Linux. ElevenLabs is a drop-in upgrade once a key
 * is configured.
 */
export async function speak(text: string, opts: SpeakOptions): Promise<void> {
  if (!text.trim()) return;
  if (opts.provider === "elevenlabs") {
    const key = await getElevenLabsKey();
    if (key) {
      const voiceId = opts.voiceId ?? (await loadVoiceConfig()).elevenLabsVoiceId;
      await speakElevenLabs(text, key, voiceId);
      return;
    }
    console.warn("[mimir] ElevenLabs selected but no API key stored — falling back to system TTS.");
  }
  await speakSystem(text, opts.systemVoice);
}

function speakSystem(text: string, voice?: string): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    if (voice) return runCommand("say", ["-v", voice, text]).catch(() => runCommand("say", [text]));
    return runCommand("say", [text]);
  }
  if (platform === "win32") {
    const escaped = text.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${escaped}');`;
    return runCommand("powershell", ["-NoProfile", "-Command", script]);
  }
  // Linux best-effort — try spd-say, then espeak. Neither is guaranteed installed.
  return runCommand("spd-say", [text]).catch(() => runCommand("espeak", [text]));
}

async function speakElevenLabs(text: string, apiKey: string, voiceId = DEFAULT_ELEVENLABS_VOICE_ID): Promise<void> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      text,
      // Favor natural, emotionally aware delivery over lowest latency. The
      // renderer already begins each reply at its first complete sentence.
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!res.ok) {
    console.warn(`[mimir] ElevenLabs TTS failed (${res.status}) — falling back to system TTS.`);
    return speakSystem(text);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimir-tts-"));
  const file = path.join(tmpDir, "speech.mp3");
  await writeFile(file, buffer);
  try {
    await playAudioFile(file);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function playAudioFile(file: string): Promise<void> {
  if (process.platform === "darwin") return runCommand("afplay", [file]);
  if (process.platform === "win32") {
    const script = `(New-Object Media.SoundPlayer '${file}').PlaySync();`;
    return runCommand("powershell", ["-NoProfile", "-Command", script]);
  }
  return runCommand("aplay", [file]).catch(() => runCommand("paplay", [file]));
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
