import type { BrainConfig, BrainProviderKind, EffortLevel } from "../../shared/types.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";
import { getSecret, setSecret } from "../config/keychain.js";

const FILE = "brain.json";
const KEY_ACCOUNT: Record<BrainProviderKind, string> = {
  anthropic: "brain:anthropic",
  "openai-compatible": "brain:openai-compatible",
  ollama: "brain:ollama" // typically unused (local, no key) but supported for auth'd VPS setups
};

interface StoredBrainConfig {
  provider: BrainProviderKind;
  model: string;
  baseUrl: string | null;
  autoApproveCoreEdits: boolean;
  effort: EffortLevel;
  webSearchEnabled: boolean;
}

const DEFAULTS: StoredBrainConfig = {
  // Local-first default: works offline with no API key out of the box.
  // Anthropic/other providers are one QuickControls click away.
  provider: "ollama",
  model: "llama3.2:3b",
  baseUrl: null,
  autoApproveCoreEdits: false,
  effort: "high",
  webSearchEnabled: false
};

export async function loadBrainConfig(): Promise<BrainConfig> {
  const stored = await readJsonFile<StoredBrainConfig>(FILE, DEFAULTS);
  const apiKey = await getSecret(KEY_ACCOUNT[stored.provider]);
  return { ...stored, hasApiKey: Boolean(apiKey) };
}

export async function saveBrainConfig(
  patch: Partial<Omit<BrainConfig, "hasApiKey">>
): Promise<BrainConfig> {
  const current = await readJsonFile<StoredBrainConfig>(FILE, DEFAULTS);
  const next: StoredBrainConfig = { ...current, ...patch };
  await writeJsonFile(FILE, next);
  return loadBrainConfig();
}

export async function setBrainApiKey(provider: BrainProviderKind, apiKey: string): Promise<void> {
  await setSecret(KEY_ACCOUNT[provider], apiKey);
}

export async function getBrainApiKey(provider: BrainProviderKind): Promise<string | null> {
  return getSecret(KEY_ACCOUNT[provider]);
}
