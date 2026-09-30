import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillStatus } from "../../shared/types.js";

export type { SkillStatus };

export const DEFAULT_SKILL_CATEGORY = "General";

/**
 * One skill's full record: where it sits in the tree (category + optional
 * parent it builds on) plus whether it's actually been verified to work.
 * These two concerns are written at different times by different call
 * sites (category/parent once at creation; status/verifiedAt/error on
 * every run) but live in the same JSON entry, so every write here is a
 * read-merge-write — never blindly overwrite the whole record.
 */
export interface SkillRecord {
  category: string;
  /** Name of the skill this one builds on, or null if it's a root skill
   * within its category. See tools.ts's create_skill "builds_on" param. */
  parent: string | null;
  status: SkillStatus;
  /** Epoch ms of the last verification attempt, or null if never verified. */
  verifiedAt: number | null;
  /** The error message from the last failed attempt, or null. */
  error: string | null;
}

export type SkillIndex = Record<string, SkillRecord>;

const INDEX_FILE = ".mimir-index.json";

export function defaultSkillRecord(): SkillRecord {
  return { category: DEFAULT_SKILL_CATEGORY, parent: null, status: "unverified", verifiedAt: null, error: null };
}

/**
 * Tracks the skill tree's structure and whether each skill has actually
 * been run and succeeded — "verified" here means "ran without raising a
 * Python error," not "does exactly what its description claims." That's an
 * honest, real signal (catches syntax errors, missing-import errors,
 * broken logic that throws) without overclaiming semantic correctness the
 * sandbox can't actually check. Stored as one small JSON file alongside
 * the skills themselves, so it travels with the git history
 * versionedFolder.ts already gives the skill library.
 */
export async function readSkillIndex(skillsRoot: string): Promise<SkillIndex> {
  const file = path.join(skillsRoot, INDEX_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(await readFile(file, "utf-8")) as SkillIndex;
  } catch {
    return {};
  }
}

async function writeSkillIndex(skillsRoot: string, index: SkillIndex): Promise<void> {
  await writeFile(path.join(skillsRoot, INDEX_FILE), JSON.stringify(index, null, 2), "utf-8");
}

/** Sets where a skill sits in the tree — called once at creation. Merges
 * onto whatever verification result already exists rather than resetting
 * it, so re-saving a skill with new metadata doesn't wipe its status. */
export async function writeSkillMetadata(
  skillsRoot: string,
  name: string,
  metadata: { category: string; parent: string | null }
): Promise<void> {
  const index = await readSkillIndex(skillsRoot);
  const existing = index[name] ?? defaultSkillRecord();
  index[name] = { ...existing, ...metadata };
  await writeSkillIndex(skillsRoot, index);
}

/** Records a run's pass/fail outcome — called on every create/run/verify.
 * Merges onto whatever category/parent already exists rather than
 * resetting it. */
export async function writeSkillVerificationResult(
  skillsRoot: string,
  name: string,
  result: { status: SkillStatus; verifiedAt: number | null; error: string | null }
): Promise<void> {
  const index = await readSkillIndex(skillsRoot);
  const existing = index[name] ?? defaultSkillRecord();
  index[name] = { ...existing, ...result };
  await writeSkillIndex(skillsRoot, index);
}

export async function removeSkillVerification(skillsRoot: string, name: string): Promise<void> {
  const index = await readSkillIndex(skillsRoot);
  if (!(name in index)) return;
  delete index[name];
  await writeSkillIndex(skillsRoot, index);
}
