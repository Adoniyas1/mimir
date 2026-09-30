import path from "node:path";

/** Everything persona-related lives under `<workspace>/persona/` so it's
 * tracked by the same git repo (and gets the same audit/revert machinery)
 * as the rest of Mimir's self-editable state. */
export function personaDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "persona");
}

export function personaFilePath(workspaceRoot: string, file: string): string {
  return path.join(personaDir(workspaceRoot), file);
}

/** Relative-to-workspace-root path for a persona file, e.g. "persona/SOUL.md" —
 * this is the form SelfEditTransaction writes expect. */
export function personaRelativePath(file: string): string {
  return path.posix.join("persona", file);
}

export function dailyLogDir(workspaceRoot: string): string {
  return path.join(personaDir(workspaceRoot), "logs", "daily");
}

export function dailyLogRelativePath(dateISO: string): string {
  return path.posix.join("persona", "logs", "daily", `${dateISO}.md`);
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
