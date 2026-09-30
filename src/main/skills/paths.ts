import os from "node:os";
import path from "node:path";

/**
 * Where Mimir's self-taught skill library lives — a plain, visible folder
 * in Documents, separate from both the self-edit workspace (Mimir's own
 * app source) and the Projects folder (the user's files). Each skill is
 * just a Python script + a markdown doc, git-versioned the same lightweight
 * way as Projects (see ./versioning.ts). Deliberately NOT the same
 * mechanism as propose_edit's tier:"skill" edits (which write TypeScript
 * capability modules into the running app and require a typecheck): a
 * skill here is plain data, executed on demand via the sandboxed
 * run_python bridge, not wired into the app's own source at all. That's
 * what makes it safe for any model regardless of size, and portable —
 * switching which AI is running Mimir doesn't lose anything, since the
 * skill files themselves don't change.
 */
export function defaultSkillsRoot(): string {
  return path.join(os.homedir(), "Documents", "Mimir Skills");
}
