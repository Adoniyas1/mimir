import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Deliberately duplicated from src/main/config/store.ts rather than
 * imported: supervisor/ must stay independent of anything under src/main
 * so a broken self-edit can never touch the code that would revert it.
 */
export const MIMIR_HOME = path.join(os.homedir(), ".mimir");
const BOOT_ATTEMPTS_FILE = path.join(MIMIR_HOME, "boot-attempts.json");
const ACTIVE_FILE = path.join(MIMIR_HOME, "active.json");

export interface ActivePointer {
  /** Absolute path to the directory whose dist/main/index.js should be launched. */
  activeDir: string | null;
  revision: string | null;
  updatedAt: number;
}

export async function readBootAttempts(): Promise<number> {
  if (!existsSync(BOOT_ATTEMPTS_FILE)) return 0;
  try {
    const raw = await readFile(BOOT_ATTEMPTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { consecutiveFailures?: number };
    return typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0;
  } catch {
    return 0;
  }
}

export async function writeBootAttempts(consecutiveFailures: number): Promise<void> {
  await mkdir(MIMIR_HOME, { recursive: true });
  await writeFile(BOOT_ATTEMPTS_FILE, JSON.stringify({ consecutiveFailures }, null, 2), "utf-8");
}

export async function readActivePointer(): Promise<ActivePointer | null> {
  if (!existsSync(ACTIVE_FILE)) return null;
  try {
    const raw = await readFile(ACTIVE_FILE, "utf-8");
    return JSON.parse(raw) as ActivePointer;
  } catch {
    return null;
  }
}

export async function writeActivePointer(pointer: ActivePointer): Promise<void> {
  await mkdir(MIMIR_HOME, { recursive: true });
  await writeFile(ACTIVE_FILE, JSON.stringify(pointer, null, 2), "utf-8");
}
