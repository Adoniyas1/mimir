import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** ~/.mimir — all of Mimir's own config, kept out of the editable workspace. */
export const MIMIR_HOME = path.join(os.homedir(), ".mimir");

export async function ensureMimirHome(): Promise<void> {
  if (!existsSync(MIMIR_HOME)) await mkdir(MIMIR_HOME, { recursive: true });
}

/** Small typed JSON-file store. One file per concern (brain.json, voice.json, ...). */
export async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  await ensureMimirHome();
  const file = path.join(MIMIR_HOME, name);
  if (!existsSync(file)) return fallback;
  try {
    const raw = await readFile(file, "utf-8");
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export async function writeJsonFile<T>(name: string, value: T): Promise<void> {
  await ensureMimirHome();
  const file = path.join(MIMIR_HOME, name);
  await writeFile(file, JSON.stringify(value, null, 2), "utf-8");
}
