import { mkdir, writeFile } from "node:fs/promises";
import { MIMIR_HOME } from "./config/store.js";
import path from "node:path";

const BOOT_ATTEMPTS_FILE = path.join(MIMIR_HOME, "boot-attempts.json");

/**
 * Called once the main window is actually up and interactive. Resets the
 * crash-loop counter that electron-entry.mjs (and supervisor/) consult on
 * the *next* launch, and prints the marker they watch for on stdout.
 */
export async function reportHealthy(): Promise<void> {
  await mkdir(MIMIR_HOME, { recursive: true });
  await writeFile(BOOT_ATTEMPTS_FILE, JSON.stringify({ consecutiveFailures: 0 }, null, 2), "utf-8");
  console.log("MIMIR_HEALTHY");
}
