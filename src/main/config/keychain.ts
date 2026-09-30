/**
 * Thin wrapper around keytar, so secrets (Anthropic key, Picovoice key,
 * ElevenLabs key, VPS bearer tokens) never touch disk in plaintext and
 * never get written into the self-editable workspace where an agent tool
 * could accidentally read or leak them.
 *
 * keytar is a native module — it can fail to load in some sandboxed dev
 * environments (no OS keychain daemon). We degrade to an in-memory store
 * in that case rather than crashing, and log loudly so it's obvious this
 * is not persistent.
 */

const SERVICE = "Mimir";

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytar: KeytarModule | null = null;
let keytarLoadAttempted = false;
const memoryFallback = new Map<string, string>();

async function loadKeytar(): Promise<KeytarModule | null> {
  if (keytarLoadAttempted) return keytar;
  keytarLoadAttempted = true;
  try {
    const mod = (await import("keytar")) as unknown as { default: KeytarModule };
    keytar = mod.default;
  } catch (err) {
    console.warn(
      "[mimir] keytar unavailable — falling back to an in-memory secret store for this session.",
      err instanceof Error ? err.message : err
    );
    keytar = null;
  }
  return keytar;
}

export async function getSecret(account: string): Promise<string | null> {
  const kt = await loadKeytar();
  if (kt) return kt.getPassword(SERVICE, account);
  return memoryFallback.get(account) ?? null;
}

export async function setSecret(account: string, value: string): Promise<void> {
  const kt = await loadKeytar();
  if (kt) {
    await kt.setPassword(SERVICE, account, value);
    return;
  }
  memoryFallback.set(account, value);
}

export async function deleteSecret(account: string): Promise<void> {
  const kt = await loadKeytar();
  if (kt) {
    await kt.deletePassword(SERVICE, account);
    return;
  }
  memoryFallback.delete(account);
}
