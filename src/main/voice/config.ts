import type { VoiceConfig } from "../../shared/types.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";
import { getSecret, setSecret } from "../config/keychain.js";

const FILE = "voice.json";
const PICOVOICE_ACCOUNT = "voice:picovoice";
const ELEVENLABS_ACCOUNT = "voice:elevenlabs";
export const DEFAULT_ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

interface StoredVoiceConfig {
  wakeWordEnabled: boolean;
  openMicEnabled: boolean;
  ttsProvider: "system" | "elevenlabs";
  elevenLabsVoiceId: string;
  systemVoice: string;
  wakeWordPath: string | null;
  /** Seconds to keep listening after a spoken reply before requiring the
   * wake word again. 0 disables follow-up listening entirely. */
  followUpListenSeconds: number;
}

const DEFAULTS: StoredVoiceConfig = {
  wakeWordEnabled: false, // off until a Picovoice key is present — see loadVoiceConfig
  openMicEnabled: false,
  ttsProvider: "system",
  elevenLabsVoiceId: DEFAULT_ELEVENLABS_VOICE_ID,
  systemVoice: "Samantha",
  wakeWordPath: null,
  followUpListenSeconds: 0
};

export async function loadVoiceConfig(): Promise<VoiceConfig> {
  const stored = await readJsonFile<StoredVoiceConfig>(FILE, DEFAULTS);
  const [picovoiceKey, elevenLabsKey] = await Promise.all([
    getSecret(PICOVOICE_ACCOUNT),
    getSecret(ELEVENLABS_ACCOUNT)
  ]);
  return {
    wakeWordEnabled: stored.wakeWordEnabled && Boolean(picovoiceKey),
    openMicEnabled: stored.openMicEnabled,
    hasPicovoiceKey: Boolean(picovoiceKey),
    ttsProvider: stored.ttsProvider,
    hasElevenLabsKey: Boolean(elevenLabsKey),
    elevenLabsVoiceId: stored.elevenLabsVoiceId || DEFAULT_ELEVENLABS_VOICE_ID,
    systemVoice: stored.systemVoice.trim() || DEFAULTS.systemVoice,
    wakeWordPath: stored.wakeWordPath?.trim() || null,
    followUpListenSeconds: stored.followUpListenSeconds
  };
}

export async function saveVoiceConfig(
  patch: Partial<
    Pick<VoiceConfig, "wakeWordEnabled" | "openMicEnabled" | "ttsProvider" | "elevenLabsVoiceId" | "systemVoice" | "wakeWordPath" | "followUpListenSeconds">
  >
): Promise<VoiceConfig> {
  const current = await readJsonFile<StoredVoiceConfig>(FILE, DEFAULTS);
  const next = { ...current, ...patch };
  next.elevenLabsVoiceId = next.elevenLabsVoiceId.trim() || DEFAULT_ELEVENLABS_VOICE_ID;
  next.systemVoice = next.systemVoice.trim() || DEFAULTS.systemVoice;
  next.wakeWordPath = next.wakeWordPath?.trim() || null;
  await writeJsonFile(FILE, next);
  return loadVoiceConfig();
}

export async function setPicovoiceKey(key: string): Promise<void> {
  await setSecret(PICOVOICE_ACCOUNT, key);
}

export async function getPicovoiceKey(): Promise<string | null> {
  return getSecret(PICOVOICE_ACCOUNT);
}

export async function setElevenLabsKey(key: string): Promise<void> {
  await setSecret(ELEVENLABS_ACCOUNT, key);
}

export async function getElevenLabsKey(): Promise<string | null> {
  return getSecret(ELEVENLABS_ACCOUNT);
}
