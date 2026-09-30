import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** A JSON-Schema-shaped description of a skill's call arguments — exactly
 * what becomes a dynamic tool's inputSchema.properties/required (see
 * dynamicTools.ts). Deliberately a subset of full JSON Schema (just
 * properties + required), matching what create_skill actually lets the
 * model declare. */
export interface SkillParameterSchema {
  properties: Record<string, unknown>;
  required?: string[];
}

/** Optional per-skill metadata, stored as skill.json next to skill.py and
 * SKILL.md. A skill with no manifest (or a manifest with no `parameters`)
 * stays reachable only through the generic zero-arg run_skill — this file
 * only ever gains a skill capabilities it opted into, never subtracts one
 * silently. */
export interface SkillManifest {
  /** Present only for a skill that declared call arguments — this is what
   * turns it into a real, individually-named tool (skill_<name>). */
  parameters?: SkillParameterSchema;
  /** Named host capabilities (see compute/hostCapabilities.ts) this skill's
   * code may call back into, e.g. "write_project_file". Every run gets
   * exactly these and nothing else — a per-run allowlist, not a standing
   * surface. Populated in a later phase; the shape lives here now since a
   * skill declares both facts (its arguments and its capabilities) in the
   * same place. */
  capabilities?: string[];
}

function manifestPath(skillsRoot: string, name: string): string {
  return path.join(skillsRoot, name, "skill.json");
}

/** Returns null for a skill with no manifest file, or one that fails to
 * parse/validate — never throws, since a malformed manifest should just
 * mean "this skill isn't a dynamic tool," not break run_skill/list_skills
 * for it. */
export async function readSkillManifest(skillsRoot: string, name: string): Promise<SkillManifest | null> {
  const file = manifestPath(skillsRoot, name);
  if (!existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf-8"));
    return normalizeManifest(raw);
  } catch {
    return null;
  }
}

export async function writeSkillManifest(skillsRoot: string, name: string, manifest: SkillManifest): Promise<void> {
  // create_skill's handler already creates the skill directory before this
  // is ever called in the real app, but this function should be correct on
  // its own too — mkdir here rather than assuming a caller did it first.
  await mkdir(path.join(skillsRoot, name), { recursive: true });
  await writeFile(manifestPath(skillsRoot, name), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/** Removes a stale manifest when a skill is re-saved without parameters or
 * capabilities this time — overwriting a skill must be able to make it a
 * plain zero-arg script again, not just add to what it had before. */
export async function removeSkillManifest(skillsRoot: string, name: string): Promise<void> {
  await rm(manifestPath(skillsRoot, name), { force: true });
}

function normalizeManifest(raw: unknown): SkillManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const manifest: SkillManifest = {};
  if (isValidParameterSchema(obj.parameters)) manifest.parameters = obj.parameters;
  if (Array.isArray(obj.capabilities) && obj.capabilities.every((c) => typeof c === "string")) {
    manifest.capabilities = obj.capabilities as string[];
  }
  return manifest;
}

export function isValidParameterSchema(value: unknown): value is SkillParameterSchema {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.properties !== "object" || obj.properties === null) return false;
  if (obj.required !== undefined) {
    if (!Array.isArray(obj.required) || !obj.required.every((r) => typeof r === "string")) return false;
  }
  return true;
}
