import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SOLVER_REGISTRY, resolveTimeoutSeconds, runSolver } from "../src/main/engineering/solvers.js";

describe("SOLVER_REGISTRY", () => {
  it("has exactly the five wired-up solvers, each with a sane timeout range", () => {
    for (const id of ["freecad", "calculix", "ngspice", "kicad_erc", "kicad_drc"] as const) {
      const def = SOLVER_REGISTRY[id];
      expect(def.binaryCandidates.length).toBeGreaterThan(0);
      expect(def.minTimeoutSeconds).toBeLessThanOrEqual(def.defaultTimeoutSeconds);
      expect(def.defaultTimeoutSeconds).toBeLessThanOrEqual(def.maxTimeoutSeconds);
    }
  });
});

describe("kicad_erc / kicad_drc argv (never --exit-code-violations)", () => {
  it("never asks kicad-cli to fail its exit code on real violations — that would make 'found real problems' look like 'the tool crashed'", () => {
    const ercArgs = SOLVER_REGISTRY.kicad_erc.buildArgs("/proj/cad/board.kicad_sch");
    expect(ercArgs).not.toContain("--exit-code-violations");
    expect(ercArgs[0]).toBe("sch");
    expect(ercArgs[1]).toBe("erc");
    expect(ercArgs).toContain("/proj/cad/board.kicad_sch");

    const drcArgs = SOLVER_REGISTRY.kicad_drc.buildArgs("/proj/cad/board.kicad_pcb");
    expect(drcArgs).not.toContain("--exit-code-violations");
    expect(drcArgs[0]).toBe("pcb");
    expect(drcArgs[1]).toBe("drc");
    expect(drcArgs).toContain("/proj/cad/board.kicad_pcb");
  });

  it("writes its report beside the input file, same basename, discipline-appropriate suffix", () => {
    const ercArgs = SOLVER_REGISTRY.kicad_erc.buildArgs("/proj/cad/board.kicad_sch");
    expect(ercArgs).toContain("board.erc.json");
    const drcArgs = SOLVER_REGISTRY.kicad_drc.buildArgs("/proj/cad/board.kicad_pcb");
    expect(drcArgs).toContain("board.drc.json");
  });
});

describe("ngspice's argv (regression: -r conflicted with a netlist's own .control write block)", () => {
  it("never passes a -r flag — live-tested to be non-deterministic (sometimes writing neither file) when combined with a netlist that writes its own output", () => {
    const args = SOLVER_REGISTRY.ngspice.buildArgs("/some/project/simulation/filter.cir");
    expect(args).not.toContain("-r");
    expect(args).toEqual(["-b", "/some/project/simulation/filter.cir"]);
  });

  // Skips itself (rather than failing) on a machine without ngspice
  // installed — this is the one genuinely live test in this file, run
  // against the real binary because that's the only way the bug above was
  // ever actually caught; a fake solver can't reproduce a real ngspice
  // batch-mode quirk.
  const ngspiceInstalled = SOLVER_REGISTRY.ngspice.binaryCandidates.some((p) => existsSync(p));
  it.runIf(ngspiceInstalled)("really runs a netlist with a .control write block and produces real, non-empty .raw output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-ngspice-live-test-"));
    const netlist = path.join(dir, "rc.cir");
    await writeFile(
      netlist,
      "RC low-pass filter\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 100n\n.control\nac dec 20 10 100k\nwrite rc.raw\n.endc\n.end\n",
      "utf8"
    );
    await runSolver(SOLVER_REGISTRY.ngspice, netlist, 30);
    const raw = await readFile(path.join(dir, "rc.raw"));
    expect(raw.length).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  }, 15_000);
});

describe("resolveTimeoutSeconds", () => {
  const def = SOLVER_REGISTRY.calculix;

  it("falls back to the solver's default when nothing is given", () => {
    expect(resolveTimeoutSeconds(def, undefined)).toBe(def.defaultTimeoutSeconds);
    expect(resolveTimeoutSeconds(def, "not a number")).toBe(def.defaultTimeoutSeconds);
  });

  it("clamps a requested timeout into the solver's own min/max range", () => {
    expect(resolveTimeoutSeconds(def, 1)).toBe(def.minTimeoutSeconds);
    expect(resolveTimeoutSeconds(def, 100_000)).toBe(def.maxTimeoutSeconds);
    expect(resolveTimeoutSeconds(def, 60)).toBe(60);
  });
});

describe("runSolver", () => {
  it("rejects with a clean 'not installed' message rather than throwing a raw ENOENT when the binary is missing", async () => {
    const fakeDef = {
      id: "fake",
      label: "Fake Solver",
      binaryCandidates: ["/definitely/not/a/real/path/fake-solver"],
      buildArgs: (input: string) => [input],
      minTimeoutSeconds: 5,
      maxTimeoutSeconds: 300,
      defaultTimeoutSeconds: 30
    };
    await expect(runSolver(fakeDef, "/tmp/whatever.inp", 5)).rejects.toThrow(/not installed/i);
  });

  it("picks the first existing binary candidate and rejects on a nonzero exit code", async () => {
    // /usr/bin/false always exits 1 — a real, always-present binary this
    // test can use without depending on FreeCAD/CalculiX/ngspice actually
    // being installed on the machine running the test.
    const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-solver-test-"));
    const input = path.join(dir, "job.inp");
    await writeFile(input, "irrelevant", "utf8");
    const fakeDef = {
      id: "false",
      label: "false(1)",
      binaryCandidates: ["/no/such/binary", "/usr/bin/false"],
      buildArgs: () => [] as string[],
      minTimeoutSeconds: 5,
      maxTimeoutSeconds: 300,
      defaultTimeoutSeconds: 30
    };
    await expect(runSolver(fakeDef, input, 10)).rejects.toThrow(/exited with code/i);
    await rm(dir, { recursive: true, force: true });
  });

  it("kills a genuinely hung process once its timeout elapses", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-solver-test-"));
    const input = path.join(dir, "job.inp");
    await writeFile(input, "irrelevant", "utf8");
    // /bin/sleep 30 outlives the 1-second timeout below by a wide margin —
    // this proves runSolver's SIGTERM/timeout path actually fires rather
    // than waiting for the real 30s to elapse.
    const fakeDef = {
      id: "sleep",
      label: "sleep(1)",
      binaryCandidates: ["/bin/sleep"],
      buildArgs: () => ["30"],
      minTimeoutSeconds: 1,
      maxTimeoutSeconds: 300,
      defaultTimeoutSeconds: 1
    };
    await expect(runSolver(fakeDef, input, 1)).rejects.toThrow(/exceeded its 1-second limit/i);
    await rm(dir, { recursive: true, force: true });
  }, 10_000);

  it("confines nothing itself — that's the calling tool's job (resolveConfinedPath), documented so this isn't mistaken for a second confinement layer", () => {
    // No assertion beyond existence: runSolver takes an already-resolved
    // absolute path and never touches projectsRoot or any confinement
    // logic — see engineering/tools.ts, which resolves the path via
    // resolveConfinedPath before ever calling runSolver.
    expect(typeof runSolver).toBe("function");
  });
});
