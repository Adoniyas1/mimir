import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface FolderHistoryEntry {
  hash: string;
  date: string;
  message: string;
}

/**
 * Lightweight version history for a plain data folder (the Projects
 * folder, the skill library, ...) — separate from self-edit's
 * SelfEditTransaction, which is for Mimir's own app source and carries a
 * verify pipeline and (for core edits) an approval gate that don't make
 * sense for a plain file save. This is just "so an overwrite isn't
 * permanently destructive": init the folder's own git repo once (lazily,
 * on first use), commit on every write, and a couple of functions to look
 * at and undo history. No verify pipeline, no approval — same trust level
 * as the write itself.
 */
async function ensureRepo(root: string): Promise<SimpleGit> {
  const git = simpleGit(root);
  if (!existsSync(path.join(root, ".git"))) {
    await git.init();
    await git.addConfig("user.name", "Mimir");
    await git.addConfig("user.email", "mimir@localhost");
    const status = await git.status();
    if (status.files.length > 0) {
      await git.add(["-A"]);
      await git.commit("mimir: initial snapshot");
    }
  }
  return git;
}

/** Commits whatever's currently changed under `root` (which may be more
 * than just the file `summary` describes — e.g. something dropped in via
 * Finder since the last write). No-ops if nothing actually changed. */
export async function commitFolderChange(root: string, summary: string): Promise<void> {
  const git = await ensureRepo(root);
  const status = await git.status();
  if (status.files.length === 0) return;
  await git.add(["-A"]);
  await git.commit(summary);
}

export async function listFolderHistory(root: string, relFile?: string, limit = 20): Promise<FolderHistoryEntry[]> {
  if (!existsSync(path.join(root, ".git"))) return [];
  const git = simpleGit(root);
  const log = await git.log({ file: relFile, maxCount: limit });
  return log.all.map((entry) => ({ hash: entry.hash.slice(0, 10), date: entry.date, message: entry.message }));
}

/** Restores one file to its content at `commitHash`, as a new commit on
 * top (not a hard reset) — the revert itself stays undoable the same way. */
export async function revertFolderFile(root: string, relFile: string, commitHash: string): Promise<void> {
  const git = await ensureRepo(root);
  await git.raw(["checkout", commitHash, "--", relFile]);
  await git.add([relFile]);
  await git.commit(`mimir: reverted ${relFile} to ${commitHash.slice(0, 10)}`);
}
