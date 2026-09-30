// Immutable entry point. This file is the `main` field in package.json —
// it is never copied into the self-editable workspace (see COPY_INCLUDE in
// src/main/self-edit/workspace.ts) and no self-edit tool's path
// confinement allows writing here (tools only ever touch the workspace
// root). This is what makes "Mimir can rewrite its own core source" safe:
// the one file that decides *which* build to actually run can't be
// rewritten by the thing it's deciding about.
//
// Job: read ~/.mimir/active.json to find the most recently self-edited
// build. If it looks bootable AND the crash-loop counter is under budget,
// launch it. Otherwise (or on first run, before any self-edit has
// happened) launch this original packaged build instead.

import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const APP_ROOT = path.dirname(new URL(import.meta.url).pathname);
const MIMIR_HOME = path.join(os.homedir(), ".mimir");
const ACTIVE_FILE = path.join(MIMIR_HOME, "active.json");
const BOOT_ATTEMPTS_FILE = path.join(MIMIR_HOME, "boot-attempts.json");
const MAX_CONSECUTIVE_FAILURES = 3;

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

async function resolveEntry() {
  const attempts = await readJson(BOOT_ATTEMPTS_FILE, { consecutiveFailures: 0 });
  if ((attempts.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(
      `[mimir] ${attempts.consecutiveFailures} consecutive failed boots — falling back to the original install.`
    );
    await mkdir(MIMIR_HOME, { recursive: true });
    await writeFile(ACTIVE_FILE, JSON.stringify({ activeDir: null, revision: null, updatedAt: Date.now() }, null, 2));
    return path.join(APP_ROOT, "dist", "main", "index.js");
  }

  const active = await readJson(ACTIVE_FILE, { activeDir: null });
  if (active.activeDir) {
    const candidate = path.join(active.activeDir, "dist", "main", "index.js");
    if (existsSync(candidate)) return candidate;
  }
  return path.join(APP_ROOT, "dist", "main", "index.js");
}

const entry = await resolveEntry();
await import(pathToFileURL(entry).href);
