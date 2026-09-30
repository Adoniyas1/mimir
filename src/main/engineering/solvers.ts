import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * One entry per external solver Mimir can drive — the alternative to a
 * hand-written run*() function per discipline (which is exactly what this
 * replaced: engineering/tools.ts used to have runFreeCadMacro and
 * runCalculiX as two separate, near-identical spawn() wrappers). Adding a
 * discipline's solver here is a data entry, not new code: binary
 * candidates to search, how to build its argv from an input file, and its
 * timeout bounds. runSolver() below is the one implementation every entry
 * shares.
 *
 * Deliberately NOT a place to add arbitrary commands: every entry here
 * still needs a real tool (in engineering/tools.ts) that confines its
 * input to a Mimir Projects folder via resolveConfinedPath before ever
 * reaching runSolver — this table only describes how to invoke a binary
 * that's already been decided to be safe to invoke, not a way to add new
 * capabilities without that review.
 */
export interface SolverDefinition {
  id: string;
  label: string;
  /** Absolute paths to try, in the order given — the first one that
   * exists on this Mac is used. Supports different install locations
   * (e.g. Homebrew's Apple Silicon vs Intel prefixes) without config. */
  binaryCandidates: string[];
  /** Builds the argv for one run, given the input file's absolute path. */
  buildArgs: (inputAbsPath: string) => string[];
  /** Working directory for the spawned process. Defaults to the input
   * file's own directory — every solver here writes its output beside its
   * input, inside the project, never anywhere else. */
  cwd?: (inputAbsPath: string) => string;
  minTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultTimeoutSeconds: number;
}

const FREECAD_BIN = "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd";
// CalculiX ships inside the FreeCAD bundle on this platform (see
// engineering/tools.ts's original comment) — same app, different binary.
const CALCULIX_BIN = "/Applications/FreeCAD.app/Contents/Resources/bin/ccx";
// Homebrew's two standard prefixes — Apple Silicon and Intel — cover every
// real install location without needing PATH lookup logic here.
const NGSPICE_CANDIDATES = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice"];
// kicad-cli ships inside the KiCad app bundle itself, same as freecadcmd/ccx
// ship inside FreeCAD's — not a separate Homebrew formula.
const KICAD_CLI_BIN = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

export type SolverId = "freecad" | "calculix" | "ngspice" | "kicad_erc" | "kicad_drc";

export const SOLVER_REGISTRY: Record<SolverId, SolverDefinition> = {
  freecad: {
    id: "freecad",
    label: "FreeCAD",
    binaryCandidates: [FREECAD_BIN],
    buildArgs: (inputAbsPath) => ["-c", inputAbsPath],
    minTimeoutSeconds: 5,
    maxTimeoutSeconds: 300,
    defaultTimeoutSeconds: 120
  },
  calculix: {
    id: "calculix",
    label: "CalculiX",
    binaryCandidates: [CALCULIX_BIN],
    // ccx's own convention: pass the job name with -i, not the file path —
    // it appends .inp itself and writes every output beside it.
    buildArgs: (inputAbsPath) => ["-i", path.basename(inputAbsPath, ".inp")],
    cwd: (inputAbsPath) => path.dirname(inputAbsPath),
    minTimeoutSeconds: 5,
    maxTimeoutSeconds: 300,
    defaultTimeoutSeconds: 120
  },
  ngspice: {
    id: "ngspice",
    label: "ngspice",
    binaryCandidates: NGSPICE_CANDIDATES,
    // Batch mode only — no -r flag. Live-tested (spawned from Node, not a
    // TTY, exactly how this app actually runs it) with a netlist containing
    // its own .control ... write ... .endc block: adding -r <file> on top
    // of that made the run non-deterministic — sometimes ngspice wrote
    // neither file, sometimes only one — while `-b <netlist>` alone with no
    // -r flag reliably let the netlist's own `write` command produce its
    // .raw output every time (verified over multiple consecutive runs).
    // The tool's own description already tells the model to include that
    // write command itself, so nothing else has to change to rely on it.
    buildArgs: (inputAbsPath) => ["-b", inputAbsPath],
    cwd: (inputAbsPath) => path.dirname(inputAbsPath),
    minTimeoutSeconds: 5,
    maxTimeoutSeconds: 300,
    defaultTimeoutSeconds: 60
  },
  kicad_erc: {
    id: "kicad_erc",
    label: "KiCad ERC",
    binaryCandidates: [KICAD_CLI_BIN],
    // Deliberately no --exit-code-violations: that flag makes kicad-cli
    // return nonzero when it FINDS violations, and runSolver treats a
    // nonzero exit as "the tool failed to run" (mirroring CalculiX/ngspice,
    // where a nonzero exit really does mean the solver didn't complete).
    // A schematic with real ERC violations is not a failed check — it's a
    // successful check that found something. Leaving the flag off makes
    // kicad-cli exit 0 whenever it completed, so exit code stays "did this
    // run" and the report file (read separately) stays "what did it find".
    buildArgs: (inputAbsPath) => [
      "sch",
      "erc",
      "--output",
      `${path.basename(inputAbsPath, path.extname(inputAbsPath))}.erc.json`,
      "--format",
      "json",
      inputAbsPath
    ],
    cwd: (inputAbsPath) => path.dirname(inputAbsPath),
    minTimeoutSeconds: 5,
    maxTimeoutSeconds: 120,
    defaultTimeoutSeconds: 60
  },
  kicad_drc: {
    id: "kicad_drc",
    label: "KiCad DRC",
    binaryCandidates: [KICAD_CLI_BIN],
    // Same reasoning as kicad_erc above — no --exit-code-violations.
    buildArgs: (inputAbsPath) => [
      "pcb",
      "drc",
      "--output",
      `${path.basename(inputAbsPath, path.extname(inputAbsPath))}.drc.json`,
      "--format",
      "json",
      inputAbsPath
    ],
    cwd: (inputAbsPath) => path.dirname(inputAbsPath),
    minTimeoutSeconds: 5,
    maxTimeoutSeconds: 120,
    defaultTimeoutSeconds: 60
  }
};

/**
 * Runs one solver against one input file. The single implementation every
 * SOLVER_REGISTRY entry shares — this is what "adding a solver is a data
 * entry, not new code" actually means: nothing here is discipline-specific.
 */
export function runSolver(def: SolverDefinition, inputAbsPath: string, timeoutSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = def.binaryCandidates.find((candidate) => existsSync(candidate));
    if (!bin) {
      reject(new Error(`${def.label} is not installed. Install it before running this simulation.`));
      return;
    }
    const args = def.buildArgs(inputAbsPath);
    const cwd = def.cwd ? def.cwd(inputAbsPath) : path.dirname(inputAbsPath);
    const child = spawn(bin, args, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${def.label} exceeded its ${timeoutSeconds}-second limit.`));
    }, timeoutSeconds * 1000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${def.label} exited with code ${code ?? "unknown"}.`));
    });
  });
}

/** Clamps a user/model-supplied timeout into a solver's own allowed range,
 * falling back to its default when none is given — shared so every solver
 * tool validates timeouts identically instead of repeating the same
 * min/max/default dance per tool. */
export function resolveTimeoutSeconds(def: SolverDefinition, requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return def.defaultTimeoutSeconds;
  return Math.min(def.maxTimeoutSeconds, Math.max(def.minTimeoutSeconds, requested));
}
