import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeJsonFile } from "../config/store.js";

const execAsync = promisify(exec);

export interface ActivePointer {
  activeDir: string | null;
  revision: string | null;
  updatedAt: number;
}

/**
 * Builds the workspace after a successful core-tier self-edit and, if the
 * build succeeds, points the immutable entry (electron-entry.mjs) at it and
 * relaunches. If the build fails, the commit stays in the workspace's git
 * history (nothing is lost — it's just not what boots next), the pointer
 * is left untouched, and the caller is responsible for surfacing the error.
 */
export async function applyCoreEditAndMaybeRestart(
  workspaceRoot: string,
  commitSha: string,
  relaunch: () => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execAsync("npm run build", { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, error: [e.stdout, e.stderr, e.message].filter(Boolean).join("\n") };
  }

  const pointer: ActivePointer = { activeDir: workspaceRoot, revision: commitSha, updatedAt: Date.now() };
  await writeJsonFile("active.json", pointer);
  relaunch();
  return { ok: true };
}
