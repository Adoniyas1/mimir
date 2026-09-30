import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef, Toolset } from "../brain/Provider.js";
import { resolveConfinedPath } from "../self-edit/pathGuard.js";
import { commitFolderChange } from "../lib/versionedFolder.js";
import { SOLVER_REGISTRY, resolveTimeoutSeconds, runSolver } from "./solvers.js";
import { ENGINEERING_DISCIPLINES, type EngineeringDiscipline, writeInitialEngineeringStatus } from "./workflow.js";

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNSAFE_FREECAD_SOURCE = /\b(?:child_process|subprocess|socket|urllib|requests|shutil|importlib|ctypes|eval|exec|__import__)\b|\bos\.(?:system|popen|remove|unlink|rmdir|rename|replace)\b|\bopen\s*\(/i;

export interface EngineeringToolsetOptions {
  projectsRoot: string;
  runFreeCad: (macroPath: string) => Promise<void>;
  runCalculiX: (inputPath: string, timeoutSeconds: number) => Promise<void>;
  runNgspice: (inputPath: string, timeoutSeconds: number) => Promise<void>;
  runKicadErc: (inputPath: string, timeoutSeconds: number) => Promise<void>;
  runKicadDrc: (inputPath: string, timeoutSeconds: number) => Promise<void>;
}

/** One complete, deterministic design loop. It is purposefully a constrained
 * starter template instead of an arbitrary command/code runner: the model can
 * independently create a real project, but cannot silently overwrite work or
 * execute unreviewed CAD instructions on the Mac. */
export function buildEngineeringToolset(opts: EngineeringToolsetOptions): Toolset {
  const defs: ToolDef[] = [{
    name: "create_engineering_project",
    description: "Create a new, general engineering-project workspace with structured files for requirements, concepts, analysis, simulation, CAD, verification, BOM, and release. Use when the user explicitly asks to start an engineering project. It never overwrites an existing project.",
    inputSchema: {
      type: "object",
      properties: {
        project_name: { type: "string", description: "New lowercase slug, e.g. solar-charger." },
        brief: { type: "string", description: "What is being made and its intended use." },
        discipline: {
          type: "string",
          enum: [...ENGINEERING_DISCIPLINES],
          description: "Primary engineering discipline — this decides what counts as real CAD/simulation evidence for advance_engineering_stage (e.g. electrical expects a schematic/netlist and a SPICE simulation, not a FreeCAD model)."
        }
      },
      required: ["project_name", "brief"]
    }
  }, {
    name: "run_freecad_project_macro",
    description: "Run a FreeCAD Python macro already saved inside a Mimir engineering project's cad folder to generate or revise a CAD model. Use only after reviewing the macro and when the user asked for CAD work. The macro is confined to Mimir Projects and rejects network, shell, destructive-file, and dynamic-code APIs.",
    inputSchema: {
      type: "object",
      properties: { macro_path: { type: "string", description: "Project-relative path to a .py macro under its cad folder." } },
      required: ["macro_path"]
    }
  }, {
    name: "run_calculix_simulation",
    description: "Run a CalculiX finite-element simulation from a reviewed .inp file inside a Mimir engineering project. Use for structural or thermomechanical analysis after the model, material, boundary conditions, mesh, and loads have been documented. Results stay beside the input file; never present them as physical validation.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Project-relative path to a CalculiX .inp input deck." },
        timeout_seconds: { type: "number", description: "Maximum solver time, 5 to 300 seconds; defaults to 120." }
      },
      required: ["input_path"]
    }
  }, {
    name: "run_ngspice_simulation",
    description: "Run an ngspice circuit simulation from a reviewed SPICE netlist (.cir/.net/.sp) inside a Mimir engineering project — the electrical equivalent of run_calculix_simulation. Use for operating-point, transient, AC/frequency-response, or other circuit analysis after the topology, component values, and sources have been documented. The netlist should write its own results (e.g. a .control block with a `write` command); output stays beside the input file. Never present results as physical validation.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Project-relative path to a SPICE netlist (.cir, .net, or .sp)." },
        timeout_seconds: { type: "number", description: "Maximum solver time, 5 to 300 seconds; defaults to 60." }
      },
      required: ["input_path"]
    }
  }, {
    name: "run_kicad_erc",
    description: "Run KiCad's electrical rule check on a reviewed schematic (.kicad_sch) inside a Mimir engineering project — checks connectivity/rule violations (unconnected pins, conflicting power outputs, etc.), it does not simulate behavior. Use after the schematic is drawn and before treating it as complete. Writes a JSON report beside the schematic; a successful run means the check completed, not that it found zero violations — always read the report.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Project-relative path to a KiCad schematic (.kicad_sch)." },
        timeout_seconds: { type: "number", description: "Maximum check time, 5 to 120 seconds; defaults to 60." }
      },
      required: ["input_path"]
    }
  }, {
    name: "run_kicad_drc",
    description: "Run KiCad's design rule check on a reviewed PCB layout (.kicad_pcb) inside a Mimir engineering project — checks physical/manufacturing rule violations (clearance, track width, unrouted nets, etc.). Use after the board is laid out and before treating it as fabrication-ready. Writes a JSON report beside the board; a successful run means the check completed, not that it found zero violations — always read the report.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Project-relative path to a KiCad PCB (.kicad_pcb)." },
        timeout_seconds: { type: "number", description: "Maximum check time, 5 to 120 seconds; defaults to 60." }
      },
      required: ["input_path"]
    }
  }];

  return { defs, handlers: {
    create_engineering_project: async (input) => {
      const name = typeof input.project_name === "string" ? input.project_name : "";
      const brief = typeof input.brief === "string" ? input.brief.trim() : "";
      const discipline: EngineeringDiscipline =
        typeof input.discipline === "string" && (ENGINEERING_DISCIPLINES as readonly string[]).includes(input.discipline)
          ? (input.discipline as EngineeringDiscipline)
          : "multidisciplinary";
      if (!PROJECT_NAME_RE.test(name)) return { content: "Project name must be a lowercase slug using letters, numbers, and hyphens.", isError: true };
      if (!brief) return { content: "A short project brief is required.", isError: true };
      try {
        const root = resolveConfinedPath(opts.projectsRoot, name);
        if (existsSync(root)) return { content: `A project named ${name} already exists. Choose a new name so nothing is overwritten.`, isError: true };
        await mkdir(path.join(root, "cad"), { recursive: true });
        await mkdir(path.join(root, "simulation"), { recursive: true });
        const files: Record<string, string> = {
          "README.md": `# ${name}\n\n## Brief\n\n${brief}\n\nPrimary discipline: ${discipline}.\n\nThis project follows Mimir's engineering process. Analyses and simulations are decision support, not certification.\n`,
          "requirements.md": "# Requirements\n\n| ID | Requirement | Rationale | Verification | Status |\n| --- | --- | --- | --- | --- |\n| REQ-001 | Define the problem and measurable success criteria. | Project brief | Review | Open |\n",
          "concepts.md": "# Concepts and Trade Study\n\nDocument at least two viable concepts, selection criteria, assumptions, and the chosen concept with its trade-offs.\n",
          "analysis.md": "# Engineering Analysis\n\nRecord inputs, units, governing equations, calculations, material properties, assumptions, and limits of validity.\n",
          "simulation/README.md": disciplineSimulationReadme(discipline),
          "cad/README.md": disciplineCadReadme(discipline),
          "test_plan.md": "# Verification and Test Plan\n\nMap every requirement to inspection, analysis, simulation, or physical test. Define acceptance criteria and safety precautions before testing.\n",
          "BOM.csv": "part_number,description,quantity,revision,source,status\n",
          "release_checklist.md": "# Release Checklist\n\n- [ ] Requirements reviewed.\n- [ ] Concepts traded and decision recorded.\n- [ ] Analysis and simulation assumptions reviewed.\n- [ ] CAD revision exported and inspected.\n- [ ] Physical verification completed where required.\n- [ ] Release approved.\n"
        };
        await Promise.all(Object.entries(files).map(([relative, content]) => writeFile(path.join(root, relative), content, "utf8")));
        await writeInitialEngineeringStatus(root, discipline);
        await commitFolderChange(opts.projectsRoot, `mimir: created engineering project ${name}`).catch(() => undefined);
        return { content: `Created engineering project ${name} (${discipline}) with requirements, concepts, analysis, simulation, CAD, verification, BOM, and release workspaces. Start by filling requirements.md before making design decisions.` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    },
    run_freecad_project_macro: async (input) => {
      const macroPath = typeof input.macro_path === "string" ? input.macro_path : "";
      if (!macroPath.endsWith(".py") || !/^[^/]+\/cad\/.+\.py$/.test(macroPath)) return { content: "Macro path must be a .py file directly under an engineering project's cad folder.", isError: true };
      try {
        const abs = resolveConfinedPath(opts.projectsRoot, macroPath);
        if (!existsSync(abs)) return { content: `CAD macro not found: ${macroPath}`, isError: true };
        const source = await readFile(abs, "utf8");
        if (source.length > 250_000 || UNSAFE_FREECAD_SOURCE.test(source)) return { content: "CAD macro uses a blocked API or is too large. FreeCAD macros may model and export project files but cannot use network, shell, destructive-file, or dynamic-code APIs.", isError: true };
        await opts.runFreeCad(abs);
        await commitFolderChange(opts.projectsRoot, `mimir: ran FreeCAD macro ${macroPath}`).catch(() => undefined);
        return { content: `Ran FreeCAD macro ${macroPath}. Inspect the generated model and exports before relying on them.` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    },
    run_calculix_simulation: async (input) => {
      const inputPath = typeof input.input_path === "string" ? input.input_path : "";
      const timeout = resolveTimeoutSeconds(SOLVER_REGISTRY.calculix, input.timeout_seconds);
      if (!inputPath.endsWith(".inp")) return { content: "Simulation input must be a CalculiX .inp file.", isError: true };
      try {
        const abs = resolveConfinedPath(opts.projectsRoot, inputPath);
        if (!existsSync(abs)) return { content: `CalculiX input not found: ${inputPath}`, isError: true };
        await opts.runCalculiX(abs, timeout);
        await commitFolderChange(opts.projectsRoot, `mimir: ran CalculiX ${inputPath}`).catch(() => undefined);
        return { content: `CalculiX completed for ${inputPath}. Review the .dat, .sta, .frd, and result files alongside mesh and convergence checks before making a design decision.` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    },
    run_ngspice_simulation: async (input) => {
      const inputPath = typeof input.input_path === "string" ? input.input_path : "";
      const timeout = resolveTimeoutSeconds(SOLVER_REGISTRY.ngspice, input.timeout_seconds);
      if (!/\.(cir|net|sp)$/i.test(inputPath)) return { content: "Simulation input must be a SPICE netlist (.cir, .net, or .sp).", isError: true };
      try {
        const abs = resolveConfinedPath(opts.projectsRoot, inputPath);
        if (!existsSync(abs)) return { content: `ngspice netlist not found: ${inputPath}`, isError: true };
        await opts.runNgspice(abs, timeout);
        await commitFolderChange(opts.projectsRoot, `mimir: ran ngspice ${inputPath}`).catch(() => undefined);
        return { content: `ngspice completed for ${inputPath}. Review the .raw output and solver log alongside convergence and units before making a design decision.` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    },
    run_kicad_erc: async (input) => {
      const inputPath = typeof input.input_path === "string" ? input.input_path : "";
      const timeout = resolveTimeoutSeconds(SOLVER_REGISTRY.kicad_erc, input.timeout_seconds);
      if (!inputPath.endsWith(".kicad_sch")) return { content: "ERC input must be a KiCad schematic (.kicad_sch).", isError: true };
      try {
        const abs = resolveConfinedPath(opts.projectsRoot, inputPath);
        if (!existsSync(abs)) return { content: `KiCad schematic not found: ${inputPath}`, isError: true };
        await opts.runKicadErc(abs, timeout);
        await commitFolderChange(opts.projectsRoot, `mimir: ran KiCad ERC on ${inputPath}`).catch(() => undefined);
        return { content: `KiCad ERC completed for ${inputPath}. Read the .erc.json report before deciding the schematic is clean — a completed run does not mean zero violations.` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    },
    run_kicad_drc: async (input) => {
      const inputPath = typeof input.input_path === "string" ? input.input_path : "";
      const timeout = resolveTimeoutSeconds(SOLVER_REGISTRY.kicad_drc, input.timeout_seconds);
      if (!inputPath.endsWith(".kicad_pcb")) return { content: "DRC input must be a KiCad PCB (.kicad_pcb).", isError: true };
      try {
        const abs = resolveConfinedPath(opts.projectsRoot, inputPath);
        if (!existsSync(abs)) return { content: `KiCad PCB not found: ${inputPath}`, isError: true };
        await opts.runKicadDrc(abs, timeout);
        await commitFolderChange(opts.projectsRoot, `mimir: ran KiCad DRC on ${inputPath}`).catch(() => undefined);
        return { content: `KiCad DRC completed for ${inputPath}. Read the .drc.json report before treating the board as fabrication-ready — a completed run does not mean zero violations.` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
    }
  } };
}

function disciplineCadReadme(discipline: EngineeringDiscipline): string {
  if (discipline === "electrical") {
    return "# Schematic / PCB\n\nKeep the schematic (.kicad_sch), netlist, and any board files here. Review each netlist before simulating it.\n";
  }
  if (discipline === "thermal" || discipline === "chemical" || discipline === "industrial") {
    return "# Layout / Process Diagram\n\nKeep layout drawings, PIDs, or equipment diagrams here (FreeCAD, DXF, or PDF) — parametric CAD isn't assumed for this discipline.\n";
  }
  return "# CAD\n\nKeep parameterized FreeCAD macros and generated FCStd/STEP files here. Review each macro before running it.\n";
}

function disciplineSimulationReadme(discipline: EngineeringDiscipline): string {
  if (discipline === "electrical") {
    return "# Simulation Plan\n\nRecord the netlist, sources, sweep/analysis type, and result interpretation. Put SPICE netlists (.cir/.net/.sp) and ngspice output (.raw/.log) in this folder.\n";
  }
  if (discipline === "thermal" || discipline === "chemical" || discipline === "industrial") {
    return "# Simulation Plan\n\nRecord property-data sources, governing equations or solver used, assumptions, and result interpretation. Put structured outputs (.csv/.json/.dat) in this folder.\n";
  }
  return "# Simulation Plan\n\nRecord solver, model revision, material data source, geometry simplifications, mesh settings, boundary conditions, loads, convergence checks, and result interpretation. Put CalculiX .inp decks and outputs in this folder.\n";
}

export function runFreeCadMacro(macroPath: string): Promise<void> {
  return runSolver(SOLVER_REGISTRY.freecad, macroPath, SOLVER_REGISTRY.freecad.defaultTimeoutSeconds);
}

export function runCalculiX(inputPath: string, timeoutSeconds: number): Promise<void> {
  return runSolver(SOLVER_REGISTRY.calculix, inputPath, timeoutSeconds);
}

export function runNgspice(inputPath: string, timeoutSeconds: number): Promise<void> {
  return runSolver(SOLVER_REGISTRY.ngspice, inputPath, timeoutSeconds);
}

export function runKicadErc(inputPath: string, timeoutSeconds: number): Promise<void> {
  return runSolver(SOLVER_REGISTRY.kicad_erc, inputPath, timeoutSeconds);
}

export function runKicadDrc(inputPath: string, timeoutSeconds: number): Promise<void> {
  return runSolver(SOLVER_REGISTRY.kicad_drc, inputPath, timeoutSeconds);
}
