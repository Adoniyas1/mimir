import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolDef, Toolset } from "../brain/Provider.js";
import type { PythonRunResult, SkillSummary } from "../../shared/types.js";
import { commitFolderChange } from "../lib/versionedFolder.js";
import {
  DEFAULT_SKILL_CATEGORY,
  defaultSkillRecord,
  readSkillIndex,
  writeSkillMetadata,
  writeSkillVerificationResult,
  type SkillRecord
} from "./verification.js";
import { isValidParameterSchema, readSkillManifest, removeSkillManifest, writeSkillManifest } from "./manifest.js";
import type { RunPythonFn } from "../compute/tools.js";
import { HOST_CAPABILITY_NAMES, isHostCapabilityName } from "../compute/hostCapabilities.js";

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
// versionedFolder.ts lazily creates .git the first time a skill is saved —
// never a real skill directory, always exclude it when listing.
const IGNORED_DIRS = new Set([".git"]);

export interface SkillsToolsetOptions {
  skillsRoot: string;
  runPython: RunPythonFn;
}

/** Runs a skill's code once and records pass/fail in the verification
 * index — shared by the toolset below (create_skill/run_skill/verify_skill),
 * the standalone verifySkillNow() the UI's "Verify" button calls directly,
 * and the parameterized skill_<name> tools in dynamicTools.ts (with real
 * `args`/`capabilities` this time, everyone else omits both). Exported for
 * that reuse — one definition of "what verification means" for a skill,
 * however it's run. */
export async function runAndRecordVerification(
  skillsRoot: string,
  runPython: RunPythonFn,
  name: string,
  code: string,
  args?: Record<string, unknown>,
  capabilities?: string[]
): Promise<{ outcome: PythonRunResult; verification: Pick<SkillRecord, "status" | "verifiedAt" | "error"> }> {
  const outcome = await runPython(code, args, capabilities);
  const verification = {
    status: (outcome.error ? "failed" : "passed") as SkillRecord["status"],
    verifiedAt: Date.now(),
    error: outcome.error
  };
  await writeSkillVerificationResult(skillsRoot, name, verification).catch(() => undefined);
  return { outcome, verification };
}

/**
 * A portable, model-agnostic capability library: each skill is a Python
 * script plus a markdown doc, saved as plain files under skillsRoot (see
 * paths.ts) and git-versioned the same lightweight way as the Projects
 * folder. Deliberately NOT propose_edit/tier:"skill" — that writes
 * TypeScript modules into the running app and needs a typecheck; this is
 * just data, executed on demand via run_python's sandbox. That's what
 * makes it available to every model regardless of size (the schema here —
 * a name, a description, some code — is as simple as write_project_file,
 * which is already proven reliable on small local models), and portable:
 * switching which AI is running Mimir doesn't lose anything, since the
 * skill files themselves never change.
 *
 * Every skill is also tracked in a small verification index (see
 * verification.ts) — "verified" means "ran without raising a Python
 * error," recorded the moment it's created and refreshed any time it's
 * run again, so the UI's skill tree can show real pass/fail status rather
 * than just "a file exists."
 */
export function buildSkillsToolset(opts: SkillsToolsetOptions): Toolset {
  const { skillsRoot, runPython } = opts;

  const defs: ToolDef[] = [
    {
      name: "create_skill",
      description:
        "Save a reusable capability as a skill: a short name, a one-line description, and the actual Python " +
        "code that does it. Use this instead of a one-off run_python call whenever you've worked out something " +
        "you (or a future version of you, even on a different model) will want to reuse — a calculation " +
        "routine, a data-processing helper, anything with lasting value. It's run once immediately after " +
        "saving to verify it actually works (catches syntax errors, missing imports, etc.) — the result tells " +
        "you whether it passed. Creating a skill with a name that already exists overwrites it, versioned like " +
        "everything else here. Skills are plain files, not a code change to Mimir itself — no restart, no " +
        "approval gate.\n\n" +
        "Skills form a tree, shown to the user as one: give each skill a category (a broad area like \"Math\", " +
        "\"Circuits\", \"Mechanics\" — skills with the same category are grouped together), and if this skill " +
        "is a natural next step from one you already have, set builds_on to that skill's exact name so the " +
        "tree shows the progression (e.g. a skill that plots one function is a sensible parent for a later " +
        "skill that overlays several, or fits a curve to data). Leave builds_on out for a skill that starts a " +
        "new line within its category.\n\n" +
        "Give it parameters when the code should take real inputs rather than being a fixed script: a JSON " +
        "Schema properties object (plus which of them are required) describing the call arguments your code " +
        "should read from a Python dict named `args` (e.g. args[\"diameter_mm\"]). A skill saved with parameters " +
        "immediately becomes its own real tool named skill_<name> — callable directly with those arguments on " +
        "your very next turn, no restart. A skill saved without parameters stays a fixed, zero-argument script, " +
        "run only via run_skill.\n\n" +
        `Give it capabilities when the code needs to reach outside its own sandbox — the only host actions a ` +
        `skill can ever call back into are: ${HOST_CAPABILITY_NAMES.join(", ")}. Every run only ever gets ` +
        "exactly the capabilities this skill declared, injected as awaitable functions on a Python object named " +
        "`mimir` (e.g. `await mimir.write_project_file(path=..., content=...)`) — never a raw filesystem, never " +
        "another tool, and never anything undeclared. Leave this out entirely for a skill that's pure " +
        "computation, which is most of them.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short slug, e.g. \"resistor_color_code\". Letters/numbers/-/_ only." },
          description: { type: "string", description: "One line: what it does." },
          code: { type: "string", description: "The Python code that implements it. Read call arguments from a dict named `args` if you declared parameters; call declared capabilities via `mimir.<name>(...)`." },
          notes: { type: "string", description: "Optional: how to use it, expected inputs, caveats." },
          category: { type: "string", description: "Broad area this belongs to, e.g. \"Math\", \"Circuits\". Defaults to \"General\"." },
          builds_on: { type: "string", description: "Optional: the exact name of an existing skill this one is a next step from." },
          parameters: {
            type: "object",
            description: "Optional: declare this skill's call arguments, turning it into a real tool named skill_<name>.",
            properties: {
              properties: { type: "object", description: "JSON Schema properties for each argument, e.g. {\"diameter_mm\": {\"type\": \"number\"}}." },
              required: { type: "array", items: { type: "string" }, description: "Names of arguments that must be given." }
            },
            required: ["properties"]
          },
          capabilities: {
            type: "array",
            items: { type: "string", enum: [...HOST_CAPABILITY_NAMES] },
            description: "Optional: named host actions this skill's code may call back into, via the `mimir` object."
          }
        },
        required: ["name", "description", "code"]
      }
    },
    {
      name: "list_skills",
      description: "List every skill you've saved so far, with its category, description, and whether it's verified working.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "run_skill",
      description:
        "Run a previously saved skill by name. Executes its Python code in the same sandbox as run_python — " +
        "print anything you want visible in the output. Also refreshes its verified status.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    {
      name: "verify_skill",
      description:
        "Re-run a saved skill purely to check whether it still works, without needing its output for anything. " +
        "Useful after editing a skill, or if the user asks whether something is actually working.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    }
  ];

  const handlers: Toolset["handlers"] = {
    create_skill: async (input) => {
      const name = requireString(input, "name");
      const description = requireString(input, "description");
      const code = requireString(input, "code");
      const notes = typeof input.notes === "string" ? input.notes : "";
      const category = typeof input.category === "string" && input.category.trim() ? input.category.trim() : DEFAULT_SKILL_CATEGORY;
      const requestedParent = typeof input.builds_on === "string" && input.builds_on.trim() ? input.builds_on.trim() : null;
      if (!NAME_RE.test(name)) {
        return { content: "Skill name must start with a letter and contain only letters, numbers, - or _.", isError: true };
      }
      let parameters: { properties: Record<string, unknown>; required?: string[] } | undefined;
      if (input.parameters !== undefined) {
        if (!isValidParameterSchema(input.parameters)) {
          return { content: "parameters must be an object with a \"properties\" object and, optionally, a \"required\" array of strings.", isError: true };
        }
        parameters = input.parameters;
      }
      let capabilities: string[] | undefined;
      if (input.capabilities !== undefined) {
        if (!Array.isArray(input.capabilities) || !input.capabilities.every((c) => typeof c === "string")) {
          return { content: "capabilities must be an array of strings.", isError: true };
        }
        const unknown = input.capabilities.filter((c) => !isHostCapabilityName(c));
        if (unknown.length > 0) {
          return { content: `Unknown capabilit${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}. Valid capabilities: ${HOST_CAPABILITY_NAMES.join(", ")}.`, isError: true };
        }
        capabilities = input.capabilities;
      }
      try {
        // A builds_on referencing a skill that doesn't exist is treated as
        // no parent (this skill becomes a root) rather than failing the
        // whole save — the code is still worth keeping even if the tree
        // placement needs a correction, which the response text flags.
        const parentExists = requestedParent ? existsSync(path.join(skillsRoot, requestedParent, "skill.py")) : false;
        const parent = requestedParent && parentExists ? requestedParent : null;

        const dir = path.join(skillsRoot, name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "skill.py"), code, "utf-8");
        await writeFile(path.join(dir, "SKILL.md"), renderSkillDoc(name, description, code, notes), "utf-8");
        await writeSkillMetadata(skillsRoot, name, { category, parent });
        // Re-saving a skill without parameters or capabilities this time
        // must actually clear a previous manifest, not just skip writing a
        // new one — otherwise a skill can only ever gain a tool projection
        // or a capability, never lose one, on overwrite.
        if (parameters || capabilities) await writeSkillManifest(skillsRoot, name, { parameters, capabilities });
        else await removeSkillManifest(skillsRoot, name);

        const parentNote = requestedParent && !parentExists ? ` (note: no skill named "${requestedParent}" — saved as a root instead)` : "";
        const capabilityNote = capabilities?.length ? ` It can call: ${capabilities.join(", ")}.` : "";

        if (parameters) {
          // A parameterized skill's code expects real args (e.g.
          // args["diameter_mm"]) that don't exist yet at save time — running
          // it now with an empty args dict would raise on nearly every
          // genuinely parameterized skill and record a false "failed"
          // status. Verification instead happens honestly, with real
          // arguments, the first time skill_<name> is actually called (see
          // dynamicTools.ts) — stale status from an earlier save is cleared
          // here rather than left to mislead in the meantime.
          await writeSkillVerificationResult(skillsRoot, name, { status: "unverified", verifiedAt: null, error: null });
          await commitFolderChange(skillsRoot, `mimir: saved skill "${name}"`).catch(() => undefined);
          return {
            content: `Saved skill "${name}" in ${category} as its own tool, skill_${name}.${parentNote}${capabilityNote} It takes real arguments, so it's verified the first time you actually call it rather than right now.`
          };
        }

        // No parameters, so a zero-arg verification run right now is still
        // honest — but it needs the same declared capabilities a real call
        // would get, or a skill whose whole job is e.g. writing a fixed
        // project file would spuriously fail verification for lacking the
        // `mimir` object it depends on.
        const { outcome, verification } = await runAndRecordVerification(skillsRoot, runPython, name, code, undefined, capabilities);
        await commitFolderChange(skillsRoot, `mimir: saved skill "${name}"`).catch(() => undefined);

        if (verification.status === "passed") {
          return {
            content: `Saved skill "${name}" in ${category} — verified, it runs without error.${parentNote}${capabilityNote} Run it any time with run_skill.`
          };
        }
        return {
          content: `Saved skill "${name}" in ${category}, but it failed verification:\n${outcome.error}\n${parentNote}You may want to fix and re-save it.`
        };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    list_skills: async () => {
      try {
        if (!existsSync(skillsRoot)) return { content: "No skills saved yet." };
        const entries = await readdir(skillsRoot, { withFileTypes: true });
        const names = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name)).map((e) => e.name);
        if (names.length === 0) return { content: "No skills saved yet." };
        const index = await readSkillIndex(skillsRoot);
        const lines: string[] = [];
        for (const name of names.sort()) {
          const description = await readSkillDescription(skillsRoot, name);
          const record = { ...defaultSkillRecord(), ...index[name] };
          const lineage = record.parent ? `${record.category} > ${record.parent}` : record.category;
          lines.push(`[${lineage}] ${name} [${record.status}]${description ? ` — ${description}` : ""}`);
        }
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    run_skill: async (input) => {
      const name = requireString(input, "name");
      if (!NAME_RE.test(name)) {
        return { content: "Skill name must start with a letter and contain only letters, numbers, - or _.", isError: true };
      }
      const scriptPath = path.join(skillsRoot, name, "skill.py");
      if (!existsSync(scriptPath)) {
        return { content: `No skill named "${name}". Use list_skills to see what's saved.`, isError: true };
      }
      try {
        const code = await readFile(scriptPath, "utf-8");
        const manifest = await readSkillManifest(skillsRoot, name);
        const capabilities = (manifest?.capabilities ?? []).filter(isHostCapabilityName);
        const { outcome } = await runAndRecordVerification(skillsRoot, runPython, name, code, undefined, capabilities);
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
        return { content: errMsg(err), isError: true };
      }
    },

    verify_skill: async (input) => {
      const name = requireString(input, "name");
      if (!NAME_RE.test(name)) {
        return { content: "Skill name must start with a letter and contain only letters, numbers, - or _.", isError: true };
      }
      const scriptPath = path.join(skillsRoot, name, "skill.py");
      if (!existsSync(scriptPath)) {
        return { content: `No skill named "${name}". Use list_skills to see what's saved.`, isError: true };
      }
      try {
        const code = await readFile(scriptPath, "utf-8");
        const manifest = await readSkillManifest(skillsRoot, name);
        const capabilities = (manifest?.capabilities ?? []).filter(isHostCapabilityName);
        const { verification } = await runAndRecordVerification(skillsRoot, runPython, name, code, undefined, capabilities);
        return verification.status === "passed"
          ? { content: `"${name}" is verified — it runs without error.` }
          : { content: `"${name}" failed verification:\n${verification.error}`, isError: true };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    }
  };

  return { defs, handlers };
}

/** Everything the Skill Tree UI needs, read directly — not routed through
 * the agent tool loop since this is the renderer asking on its own, not
 * the model. */
export async function listSkillSummaries(skillsRoot: string): Promise<SkillSummary[]> {
  if (!existsSync(skillsRoot)) return [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  const index = await readSkillIndex(skillsRoot);
  const summaries: SkillSummary[] = [];
  for (const name of names) {
    const description = (await readSkillDescription(skillsRoot, name)) ?? "";
    const code = await readFile(path.join(skillsRoot, name, "skill.py"), "utf-8").catch(() => "");
    const record = { ...defaultSkillRecord(), ...index[name] };
    const manifest = await readSkillManifest(skillsRoot, name);
    summaries.push({
      name,
      description,
      code,
      status: record.status,
      verifiedAt: record.verifiedAt,
      error: record.error,
      category: record.category,
      parent: record.parent,
      hasParameters: Boolean(manifest?.parameters)
    });
  }
  return summaries;
}

/** Re-verifies one skill on demand — what the UI's "Verify" button calls.
 * A parameterized skill is re-run with no arguments, same as the
 * initial-save path skips it for — see the comment in create_skill's
 * handler. Returns null if there's no skill by that name. */
export async function verifySkillNow(
  skillsRoot: string,
  name: string,
  runPython: RunPythonFn
): Promise<SkillSummary | null> {
  const scriptPath = path.join(skillsRoot, name, "skill.py");
  if (!existsSync(scriptPath)) return null;
  const code = await readFile(scriptPath, "utf-8");
  const manifest = await readSkillManifest(skillsRoot, name);
  const description = (await readSkillDescription(skillsRoot, name)) ?? "";
  const index = await readSkillIndex(skillsRoot);
  if (manifest?.parameters) {
    // Can't meaningfully verify without real arguments — leave status as
    // whatever it already is (most recently: from an actual skill_<name>
    // call) rather than manufacturing a misleading pass/fail from an
    // empty-args run.
    const record = { ...defaultSkillRecord(), ...index[name] };
    return {
      name,
      description,
      code,
      status: record.status,
      verifiedAt: record.verifiedAt,
      error: record.error,
      category: record.category,
      parent: record.parent,
      hasParameters: true
    };
  }
  const capabilities = (manifest?.capabilities ?? []).filter(isHostCapabilityName);
  const { verification } = await runAndRecordVerification(skillsRoot, runPython, name, code, undefined, capabilities);
  const record = { ...defaultSkillRecord(), ...index[name] };
  return {
    name,
    description,
    code,
    status: verification.status,
    verifiedAt: verification.verifiedAt,
    error: verification.error,
    category: record.category,
    parent: record.parent,
    hasParameters: false
  };
}

function renderSkillDoc(name: string, description: string, code: string, notes: string): string {
  const sections = [
    `# ${name}`,
    description,
    notes.trim() ? `## Notes\n\n${notes.trim()}` : "",
    `## Code\n\n\`\`\`python\n${code}\n\`\`\``
  ].filter(Boolean);
  return `${sections.join("\n\n")}\n`;
}

export async function readSkillDescription(skillsRoot: string, name: string): Promise<string | null> {
  try {
    const doc = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf-8");
    // The description is the first non-heading, non-blank line — see renderSkillDoc.
    const line = doc
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    return line ?? null;
  } catch {
    return null;
  }
}

function cap(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[...truncated...]` : text;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
