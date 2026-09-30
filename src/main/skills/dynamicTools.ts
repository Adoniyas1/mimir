import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolDef, Toolset } from "../brain/Provider.js";
import type { RunPythonFn } from "../compute/tools.js";
import { isHostCapabilityName } from "../compute/hostCapabilities.js";
import { readSkillManifest } from "./manifest.js";
import { readSkillDescription, runAndRecordVerification } from "./tools.js";

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const IGNORED_DIRS = new Set([".git"]);
// Tool names are a flat namespace shared with every other toolset
// (agent/loop.ts looks handlers up in one object where the last spread
// wins) — an unprefixed skill named e.g. "search" would silently shadow a
// native tool of the same name. Every dynamic skill tool is namespaced
// under this prefix specifically so that can't happen.
const SKILL_TOOL_PREFIX = "skill_";

export interface DynamicSkillToolsOptions {
  skillsRoot: string;
  /** Same bridge run_python/run_skill use — see compute/tools.ts. */
  runPython: RunPythonFn;
}

/**
 * Projects every parameterized skill (one saved via create_skill with a
 * `parameters` argument — see manifest.ts) into a real, individually-named
 * tool, skill_<name>, with its own JSON Schema input. This is the entire
 * "make a new tool" mechanism: no TypeScript, no rebuild, no restart, and
 * it's rebuilt fresh every turn in session.ts so a skill created mid-
 * conversation is callable on the very next turn. A skill saved without
 * parameters is unaffected — it stays reachable only through the generic,
 * zero-argument run_skill tool.
 */
export async function buildDynamicSkillTools(opts: DynamicSkillToolsOptions): Promise<Toolset> {
  const { skillsRoot, runPython } = opts;
  const defs: ToolDef[] = [];
  const handlers: Toolset["handlers"] = {};
  if (!existsSync(skillsRoot)) return { defs, handlers };

  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return { defs, handlers };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const name = entry.name;
    const manifest = await readSkillManifest(skillsRoot, name);
    if (!manifest?.parameters) continue;

    const description = await readSkillDescription(skillsRoot, name);
    const toolName = `${SKILL_TOOL_PREFIX}${name}`;
    // Silently drop anything that isn't a real, recognized capability name
    // rather than erroring the whole tool — a mistyped or since-retired
    // capability just means that one capability isn't available this run,
    // the same "fail closed, not loud" spirit as an undeclared one.
    const capabilities = (manifest.capabilities ?? []).filter(isHostCapabilityName);
    defs.push({
      name: toolName,
      description: description || `Run the "${name}" skill.`,
      inputSchema: {
        type: "object",
        properties: manifest.parameters.properties,
        required: manifest.parameters.required ?? []
      }
    });

    handlers[toolName] = async (input) => {
      const scriptPath = path.join(skillsRoot, name, "skill.py");
      if (!existsSync(scriptPath)) {
        return { content: `Skill "${name}" no longer exists — it may have been deleted or renamed.`, isError: true };
      }
      try {
        const code = await readFile(scriptPath, "utf-8");
        const { outcome } = await runAndRecordVerification(skillsRoot, runPython, name, code, input, capabilities);
        if (outcome.error) {
          const parts = [`Error running skill "${name}":\n${outcome.error}`];
          if (outcome.stdout.trim()) parts.push(`Output before the error:\n${outcome.stdout.trim()}`);
          return { content: cap(parts.join("\n\n")), isError: true };
        }
        const parts: string[] = [];
        if (outcome.stdout.trim()) parts.push(`Output:\n${outcome.stdout.trim()}`);
        if (outcome.result !== null) parts.push(`Result: ${outcome.result}`);
        return { content: cap(parts.join("\n\n")) || "(ran with no output)", images: outcome.images };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    };
  }

  return { defs, handlers };
}

function cap(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[...truncated...]` : text;
}
