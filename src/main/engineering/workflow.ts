import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import { resolveConfinedPath } from "../self-edit/pathGuard.js";
import { commitFolderChange } from "../lib/versionedFolder.js";

export const STAGES = ["requirements", "concepts", "analysis", "cad", "simulation", "verification", "release"] as const;
export type Stage = (typeof STAGES)[number];

/** mechanical/civil/aerospace share the CAD+FEA family; electrical gets its
 * own schematic/netlist+SPICE family; thermal/chemical/industrial share a
 * property-data/solver-output family that doesn't assume parametric CAD;
 * multidisciplinary accepts any one family. See DISCIPLINE_FAMILY below for
 * exactly which discipline maps to which. */
export const ENGINEERING_DISCIPLINES = [
  "mechanical",
  "electrical",
  "thermal",
  "aerospace",
  "civil",
  "chemical",
  "industrial",
  "multidisciplinary"
] as const;
export type EngineeringDiscipline = (typeof ENGINEERING_DISCIPLINES)[number];

function isEngineeringDiscipline(value: unknown): value is EngineeringDiscipline {
  return typeof value === "string" && (ENGINEERING_DISCIPLINES as readonly string[]).includes(value);
}

interface Status {
  currentStage: Stage;
  completed: Stage[];
  assumptions: string[];
  blockers: string[];
  updatedAt: string;
  discipline: EngineeringDiscipline;
}

type Family = "mechanical" | "electrical" | "analysis";
const ALL_FAMILIES: Family[] = ["mechanical", "electrical", "analysis"];

const DISCIPLINE_FAMILY: Record<EngineeringDiscipline, Family | "multidisciplinary"> = {
  mechanical: "mechanical",
  civil: "mechanical",
  aerospace: "mechanical",
  electrical: "electrical",
  thermal: "analysis",
  chemical: "analysis",
  industrial: "analysis",
  multidisciplinary: "multidisciplinary"
};

interface DirEvidence {
  dir: string;
  extensions: string[];
  description: string;
}

/** What counts as a real CAD/schematic artifact, per family — checked by
 * actually reading the directory, not assumed from a fixed filename, since
 * a real export's exact name varies per project. */
const FAMILY_CAD: Record<Family, DirEvidence[]> = {
  mechanical: [
    { dir: "cad", extensions: [".fcstd"], description: "a FreeCAD model (.FCStd)" },
    { dir: "cad", extensions: [".step", ".stp"], description: "a STEP export" }
  ],
  electrical: [{ dir: "cad", extensions: [".kicad_sch", ".kicad_pcb", ".net", ".cir"], description: "a schematic, PCB layout, or netlist (.kicad_sch/.kicad_pcb/.net/.cir)" }],
  analysis: [{ dir: "cad", extensions: [".fcstd", ".step", ".stp", ".dwg", ".dxf", ".pdf"], description: "a layout, PID, or process diagram" }]
};

/** What counts as a real simulation/analysis result, per family. */
const FAMILY_SIMULATION: Record<Family, DirEvidence[]> = {
  mechanical: [
    { dir: "simulation", extensions: [".inp"], description: "a CalculiX input deck (.inp)" },
    { dir: "simulation", extensions: [".frd", ".sta"], description: "CalculiX result output (.frd/.sta)" }
  ],
  electrical: [
    { dir: "simulation", extensions: [".cir", ".net", ".sp"], description: "a SPICE netlist" },
    { dir: "simulation", extensions: [".raw", ".log"], description: "ngspice output (.raw/.log)" }
  ],
  analysis: [{ dir: "simulation", extensions: [".csv", ".json", ".dat", ".txt", ".out", ".log"], description: "structured property-data or solver output" }]
};

// Every discipline shares these — they were never CAD/simulation-specific
// to begin with, so they stay a single plain "does this file exist" check.
const FIXED_STAGE_FILES: Partial<Record<Stage, string>> = {
  requirements: "requirements.md",
  concepts: "concepts.md",
  analysis: "analysis.md",
  verification: "test_plan.md",
  release: "release_checklist.md"
};

async function dirHasExtension(root: string, dir: string, extensions: string[]): Promise<boolean> {
  const folder = path.join(root, dir);
  if (!existsSync(folder)) return false;
  try {
    const files = await readdir(folder);
    return files.some((file) => extensions.includes(path.extname(file).toLowerCase()));
  } catch {
    return false;
  }
}

async function familyMissing(root: string, family: Family, stage: "cad" | "simulation"): Promise<string[]> {
  const requirements = stage === "cad" ? FAMILY_CAD[family] : FAMILY_SIMULATION[family];
  const missing: string[] = [];
  for (const requirement of requirements) {
    // Sequential, not Promise.all — these are a handful of directory reads
    // per project, clarity matters far more than the negligible latency.
    if (!(await dirHasExtension(root, requirement.dir, requirement.extensions))) missing.push(requirement.description);
  }
  return missing;
}

/** Regression note: the version of this function replaced here had a real
 * bug — its glob-pattern branch built `found` from an un-awaited
 * `readdir().then().catch()` chain, so `found` was always a Promise object
 * (truthy) once the directory existed, and `if (!found)` was therefore
 * always false. In effect, the CAD/simulation stage gates always reported
 * "evidence present" the moment the folder existed, regardless of what — if
 * anything — was actually inside it. */
async function missingEvidence(root: string, stage: Stage, discipline: EngineeringDiscipline): Promise<string[]> {
  if (stage === "cad" || stage === "simulation") {
    const family = DISCIPLINE_FAMILY[discipline];
    if (family !== "multidisciplinary") return familyMissing(root, family, stage);
    // multidisciplinary: satisfied if ANY one family is fully satisfied.
    // When none are, report the mechanical family's gaps — the original,
    // most common case — rather than a vague "nothing matched any family".
    const perFamily = await Promise.all(ALL_FAMILIES.map((f) => familyMissing(root, f, stage)));
    if (perFamily.some((missing) => missing.length === 0)) return [];
    return perFamily[0] ?? [];
  }
  const file = FIXED_STAGE_FILES[stage];
  return file && !existsSync(path.join(root, file)) ? [file] : [];
}

async function evidenceReport(root: string, discipline: EngineeringDiscipline): Promise<string> {
  const lines = await Promise.all(
    STAGES.map(async (stage) => `${stage}: ${(await missingEvidence(root, stage, discipline)).length ? "missing evidence" : "ready"}`)
  );
  return lines.join("\n");
}

/** A project created before this discipline table existed (or a hand-edited
 * status file) has no `discipline` field — falls back to the free-text
 * "Primary discipline: X." line create_engineering_project's README always
 * writes, and finally to "multidisciplinary" (accepts any evidence family)
 * if even that can't be read. Never throws: an unreadable README just means
 * the safest possible default, not a broken project. */
async function inferDisciplineFromReadme(root: string): Promise<EngineeringDiscipline> {
  try {
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    const match = /Primary discipline:\s*([a-z]+)/i.exec(readme);
    const value = match?.[1]?.toLowerCase();
    return isEngineeringDiscipline(value) ? value : "multidisciplinary";
  } catch {
    return "multidisciplinary";
  }
}

async function loadStatus(root: string): Promise<Status> {
  let raw: Partial<Status> = {};
  try {
    raw = JSON.parse(await readFile(path.join(root, "engineering-status.json"), "utf8")) as Partial<Status>;
  } catch {
    // No status file yet (a brand-new project) — defaults below cover it.
  }
  const discipline = isEngineeringDiscipline(raw.discipline) ? raw.discipline : await inferDisciplineFromReadme(root);
  return {
    currentStage: raw.currentStage ?? "requirements",
    completed: raw.completed ?? [],
    assumptions: raw.assumptions ?? [],
    blockers: raw.blockers ?? [],
    updatedAt: raw.updatedAt ?? "",
    discipline
  };
}

async function saveStatus(root: string, status: Status): Promise<void> {
  await writeFile(path.join(root, "engineering-status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

/** Called once by create_engineering_project right after it makes the
 * project folder, so the discipline chosen at creation is recorded
 * machine-readably from the start rather than relying purely on the
 * README fallback above. */
export async function writeInitialEngineeringStatus(root: string, discipline: EngineeringDiscipline): Promise<void> {
  await saveStatus(root, { currentStage: "requirements", completed: [], assumptions: [], blockers: [], updatedAt: "", discipline });
}

export function buildEngineeringWorkflowToolset(projectsRoot: string): Toolset {
  const defs: ToolDef[] = [
    {
      name: "inspect_engineering_workflow",
      description:
        "Inspect an engineering project's current stage, evidence files, assumptions, and blockers. Use before claiming progress or deciding the next engineering action.",
      inputSchema: { type: "object", properties: { project_name: { type: "string" } }, required: ["project_name"] }
    },
    {
      name: "advance_engineering_stage",
      description:
        "Advance a project's engineering workflow only after the required evidence files exist for its discipline (CAD/FEA for mechanical, schematic/netlist plus a simulation run for electrical, structured data/solver output for thermal or process work). Never use this to mark physical verification or release complete without user-provided test evidence and approval.",
      inputSchema: {
        type: "object",
        properties: {
          project_name: { type: "string" },
          stage: { type: "string", enum: STAGES },
          assumptions: { type: "array", items: { type: "string" } },
          blockers: { type: "array", items: { type: "string" } }
        },
        required: ["project_name", "stage"]
      }
    },
    {
      name: "record_engineering_revision",
      description:
        "Record an engineering revision, its reason, affected files, and the next validation step in a project's DESIGN_LOG.md. Use after changing a design because of analysis, simulation, or test evidence.",
      inputSchema: {
        type: "object",
        properties: {
          project_name: { type: "string" },
          summary: { type: "string" },
          affected_files: { type: "array", items: { type: "string" } },
          next_validation: { type: "string" }
        },
        required: ["project_name", "summary", "next_validation"]
      }
    }
  ];

  return {
    defs,
    handlers: {
      inspect_engineering_workflow: async (input) => {
        try {
          const root = projectRoot(projectsRoot, input);
          const status = await loadStatus(root);
          const evidence = await evidenceReport(root, status.discipline);
          return { content: `${JSON.stringify(status, null, 2)}\n\nEvidence:\n${evidence}` };
        } catch (error) {
          return errorResult(error);
        }
      },
      advance_engineering_stage: async (input) => {
        try {
          const root = projectRoot(projectsRoot, input);
          const stage = validStage(input.stage);
          const status = await loadStatus(root);
          const missing = await missingEvidence(root, stage, status.discipline);
          if (missing.length) {
            return { content: `Cannot advance ${stage} for a ${status.discipline} project; missing evidence: ${missing.join(", ")}`, isError: true };
          }
          if (stage === "release") {
            return { content: "Release cannot be marked complete automatically. Record physical verification evidence and obtain the user's explicit approval.", isError: true };
          }
          status.currentStage = stage;
          if (!status.completed.includes(stage)) status.completed.push(stage);
          status.assumptions = stringList(input.assumptions);
          status.blockers = stringList(input.blockers);
          status.updatedAt = new Date().toISOString();
          await saveStatus(root, status);
          await commitFolderChange(projectsRoot, `mimir: advanced ${path.basename(root)} to ${stage}`).catch(() => undefined);
          return { content: `Advanced ${path.basename(root)} to ${stage}. Remaining blockers: ${status.blockers.join("; ") || "none recorded"}.` };
        } catch (error) {
          return errorResult(error);
        }
      },
      record_engineering_revision: async (input) => {
        try {
          const root = projectRoot(projectsRoot, input);
          const summary = text(input.summary, "summary");
          const next = text(input.next_validation, "next_validation");
          const files = stringList(input.affected_files);
          await appendFile(
            path.join(root, "DESIGN_LOG.md"),
            `\n## ${new Date().toISOString()}\n\n${summary}\n\nAffected files: ${files.join(", ") || "not specified"}\n\nNext validation: ${next}\n`,
            "utf8"
          );
          await commitFolderChange(projectsRoot, `mimir: recorded revision for ${path.basename(root)}`).catch(() => undefined);
          return { content: "Recorded the engineering revision and next validation step." };
        } catch (error) {
          return errorResult(error);
        }
      }
    }
  };
}

function projectRoot(projectsRoot: string, input: Record<string, unknown>): string {
  const name = text(input.project_name, "project_name");
  const root = resolveConfinedPath(projectsRoot, name);
  if (!existsSync(root)) throw new Error(`Engineering project not found: ${name}`);
  return root;
}

function validStage(value: unknown): Stage {
  if (typeof value !== "string" || !STAGES.includes(value as Stage)) throw new Error("Invalid engineering stage.");
  return value as Stage;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function errorResult(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}
