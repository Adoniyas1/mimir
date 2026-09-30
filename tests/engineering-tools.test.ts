import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEngineeringToolset, type EngineeringToolsetOptions } from "../src/main/engineering/tools.js";

/** Every solver dependency defaults to a no-op — tests override only the
 * ones they actually care about, instead of repeating all five at every
 * call site. */
function engineeringOpts(root: string, overrides: Partial<EngineeringToolsetOptions> = {}): EngineeringToolsetOptions {
  return {
    projectsRoot: root,
    runFreeCad: async () => undefined,
    runCalculiX: async () => undefined,
    runNgspice: async () => undefined,
    runKicadErc: async () => undefined,
    runKicadDrc: async () => undefined,
    ...overrides
  };
}

describe("engineering automation", () => {
  it("creates a general engineering project and confines CAD/simulation execution to it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-engineering-"));
    const macros: string[] = [];
    const inputs: string[] = [];
    const tools = buildEngineeringToolset(
      engineeringOpts(root, {
        runFreeCad: async (file) => { macros.push(file); },
        runCalculiX: async (file) => { inputs.push(file); }
      })
    );
    const created = await tools.handlers.create_engineering_project?.({ project_name: "test-bracket", brief: "Hold a small sensor.", discipline: "mechanical" });
    expect(created?.isError).toBeFalsy();
    expect(await readFile(path.join(root, "test-bracket", "simulation", "README.md"), "utf8")).toContain("boundary conditions");
    const macro = path.join(root, "test-bracket", "cad", "model.py");
    await writeFile(macro, "import FreeCAD as App\nimport Part\n", "utf8");
    const ranMacro = await tools.handlers.run_freecad_project_macro?.({ macro_path: "test-bracket/cad/model.py" });
    expect(ranMacro?.isError).toBeFalsy();
    expect(macros).toEqual([macro]);
    const inp = path.join(root, "test-bracket", "simulation", "bracket.inp");
    await writeFile(inp, "*HEADING\nTest\n", "utf8");
    const ranSimulation = await tools.handlers.run_calculix_simulation?.({ input_path: "test-bracket/simulation/bracket.inp", timeout_seconds: 30 });
    expect(ranSimulation?.isError).toBeFalsy();
    expect(inputs).toEqual([inp]);
    await writeFile(path.join(root, "test-bracket", "cad", "unsafe.py"), "import os\nos.system('x')\n", "utf8");
    const unsafe = await tools.handlers.run_freecad_project_macro?.({ macro_path: "test-bracket/cad/unsafe.py" });
    expect(unsafe?.isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("runs an ngspice simulation through the confined electrical path — the same shape as run_calculix_simulation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-engineering-"));
    const ngspiceInputs: string[] = [];
    const tools = buildEngineeringToolset(
      engineeringOpts(root, { runNgspice: async (file) => { ngspiceInputs.push(file); } })
    );
    await tools.handlers.create_engineering_project?.({ project_name: "rc-filter", brief: "A simple RC low-pass filter.", discipline: "electrical" });
    expect(await readFile(path.join(root, "rc-filter", "simulation", "README.md"), "utf8")).toContain("SPICE");

    const netlist = path.join(root, "rc-filter", "simulation", "filter.cir");
    await writeFile(netlist, "* RC filter\nV1 in 0 DC 5\nR1 in out 1k\nC1 out 0 1u\n.op\n.end\n", "utf8");
    const ran = await tools.handlers.run_ngspice_simulation?.({ input_path: "rc-filter/simulation/filter.cir" });
    expect(ran?.isError).toBeFalsy();
    expect(ngspiceInputs).toEqual([netlist]);

    // Same confinement guarantee as the other solver tools — no new
    // implementation of path checking, it's inherited from resolveConfinedPath.
    const escaped = await tools.handlers.run_ngspice_simulation?.({ input_path: "../../escape.cir" });
    expect(escaped?.isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a non-netlist file extension for ngspice, mirroring CalculiX's .inp-only check", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-engineering-"));
    const tools = buildEngineeringToolset(engineeringOpts(root));
    const result = await tools.handlers.run_ngspice_simulation?.({ input_path: "whatever.txt" });
    expect(result?.isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("runs a KiCad ERC on a reviewed schematic through the confined path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-engineering-"));
    const ercInputs: string[] = [];
    const tools = buildEngineeringToolset(engineeringOpts(root, { runKicadErc: async (file) => { ercInputs.push(file); } }));
    await tools.handlers.create_engineering_project?.({ project_name: "board", brief: "A small sensor board.", discipline: "electrical" });

    const schematic = path.join(root, "board", "cad", "board.kicad_sch");
    await writeFile(schematic, "(kicad_sch (version 1))\n", "utf8");
    const ran = await tools.handlers.run_kicad_erc?.({ input_path: "board/cad/board.kicad_sch" });
    expect(ran?.isError).toBeFalsy();
    expect(ercInputs).toEqual([schematic]);

    const wrongExt = await tools.handlers.run_kicad_erc?.({ input_path: "board/cad/board.kicad_pcb" });
    expect(wrongExt?.isError).toBe(true);

    const escaped = await tools.handlers.run_kicad_erc?.({ input_path: "../../escape.kicad_sch" });
    expect(escaped?.isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("runs a KiCad DRC on a reviewed PCB through the confined path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-engineering-"));
    const drcInputs: string[] = [];
    const tools = buildEngineeringToolset(engineeringOpts(root, { runKicadDrc: async (file) => { drcInputs.push(file); } }));
    await tools.handlers.create_engineering_project?.({ project_name: "board2", brief: "A small sensor board.", discipline: "electrical" });

    const pcb = path.join(root, "board2", "cad", "board2.kicad_pcb");
    await writeFile(pcb, "(kicad_pcb (version 1))\n", "utf8");
    const ran = await tools.handlers.run_kicad_drc?.({ input_path: "board2/cad/board2.kicad_pcb" });
    expect(ran?.isError).toBeFalsy();
    expect(drcInputs).toEqual([pcb]);

    const wrongExt = await tools.handlers.run_kicad_drc?.({ input_path: "board2/cad/board2.kicad_sch" });
    expect(wrongExt?.isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
