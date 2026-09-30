import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEngineeringToolset } from "../src/main/engineering/tools.js";
import { buildEngineeringWorkflowToolset, writeInitialEngineeringStatus } from "../src/main/engineering/workflow.js";

let projectsRoot: string;

beforeEach(async () => {
  projectsRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-discipline-gates-"));
});

afterEach(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
});

async function scaffold(name: string, discipline: string): Promise<void> {
  const engineering = buildEngineeringToolset({
    projectsRoot,
    runFreeCad: async () => undefined,
    runCalculiX: async () => undefined,
    runNgspice: async () => undefined,
    runKicadErc: async () => undefined,
    runKicadDrc: async () => undefined
  });
  const created = await engineering.handlers.create_engineering_project?.({ project_name: name, brief: "test project", discipline });
  if (created?.isError) throw new Error(created.content);
  // advance_engineering_stage refuses everything but "release" without
  // requirements.md/concepts.md/analysis.md content already existing —
  // create_engineering_project already seeds those, so requirements/
  // concepts/analysis stages are ready immediately.
}

function workflow() {
  return buildEngineeringWorkflowToolset(projectsRoot);
}

describe("mechanical/civil/aerospace family — CAD + FEA (unchanged, regression)", () => {
  it.each(["mechanical", "civil", "aerospace"])("%s advances cad on .FCStd/.step and simulation on .inp + .frd/.sta", async (discipline) => {
    await scaffold("proj", discipline);
    const { handlers } = workflow();

    const blockedCad = await handlers.advance_engineering_stage?.({ project_name: "proj", stage: "cad" });
    expect(blockedCad?.isError).toBe(true);

    // Both a native model AND a STEP export are required, matching the
    // real FreeCAD macro template's own output (doc.saveAs(...) plus
    // Part.export(...)) — a .FCStd alone isn't enough.
    await writeFile(path.join(projectsRoot, "proj", "cad", "model.FCStd"), "x", "utf8");
    const onlyNative = await handlers.advance_engineering_stage?.({ project_name: "proj", stage: "cad" });
    expect(onlyNative?.isError).toBe(true);

    await writeFile(path.join(projectsRoot, "proj", "cad", "model.step"), "x", "utf8");
    const okCad = await handlers.advance_engineering_stage?.({ project_name: "proj", stage: "cad" });
    expect(okCad?.isError).toBeFalsy();

    const blockedSim = await handlers.advance_engineering_stage?.({ project_name: "proj", stage: "simulation" });
    expect(blockedSim?.isError).toBe(true);

    await writeFile(path.join(projectsRoot, "proj", "simulation", "job.inp"), "x", "utf8");
    // .inp alone still isn't enough — a result file is required too.
    const stillBlocked = await handlers.advance_engineering_stage?.({ project_name: "proj", stage: "simulation" });
    expect(stillBlocked?.isError).toBe(true);

    await writeFile(path.join(projectsRoot, "proj", "simulation", "job.frd"), "x", "utf8");
    const okSim = await handlers.advance_engineering_stage?.({ project_name: "proj", stage: "simulation" });
    expect(okSim?.isError).toBeFalsy();
  });
});

describe("electrical family — schematic/netlist + ngspice output", () => {
  it("advances cad on a netlist/schematic and simulation on a netlist + ngspice output, never asking for .FCStd", async () => {
    await scaffold("filter", "electrical");
    const { handlers } = workflow();

    await writeFile(path.join(projectsRoot, "filter", "cad", "filter.kicad_sch"), "x", "utf8");
    const okCad = await handlers.advance_engineering_stage?.({ project_name: "filter", stage: "cad" });
    expect(okCad?.isError).toBeFalsy();

    await writeFile(path.join(projectsRoot, "filter", "simulation", "filter.cir"), "x", "utf8");
    const stillBlocked = await handlers.advance_engineering_stage?.({ project_name: "filter", stage: "simulation" });
    // Netlist alone isn't enough — real ngspice output is still required.
    expect(stillBlocked?.isError).toBe(true);
    expect(stillBlocked?.content).toMatch(/ngspice/i);

    await writeFile(path.join(projectsRoot, "filter", "simulation", "filter.raw"), "x", "utf8");
    const okSim = await handlers.advance_engineering_stage?.({ project_name: "filter", stage: "simulation" });
    expect(okSim?.isError).toBeFalsy();
  });

  it("is never blocked by the absence of a .FCStd file — the historical bug this discipline table exists to fix", async () => {
    await scaffold("filter2", "electrical");
    const { handlers } = workflow();
    // No .FCStd anywhere in this project, ever — only a netlist.
    await writeFile(path.join(projectsRoot, "filter2", "cad", "filter2.net"), "x", "utf8");
    const result = await handlers.advance_engineering_stage?.({ project_name: "filter2", stage: "cad" });
    expect(result?.isError).toBeFalsy();
  });

  it("accepts a .kicad_pcb layout, not just a .kicad_sch schematic, as CAD evidence", async () => {
    await scaffold("board", "electrical");
    const { handlers } = workflow();
    await writeFile(path.join(projectsRoot, "board", "cad", "board.kicad_pcb"), "x", "utf8");
    const result = await handlers.advance_engineering_stage?.({ project_name: "board", stage: "cad" });
    expect(result?.isError).toBeFalsy();
  });
});

describe("thermal/chemical/industrial family — property-data and solver outputs", () => {
  it.each(["thermal", "chemical", "industrial"])("%s advances simulation on structured data output, not a .inp/.frd pair", async (discipline) => {
    await scaffold("proc", discipline);
    const { handlers } = workflow();

    await writeFile(path.join(projectsRoot, "proc", "cad", "layout.pdf"), "x", "utf8");
    const okCad = await handlers.advance_engineering_stage?.({ project_name: "proc", stage: "cad" });
    expect(okCad?.isError).toBeFalsy();

    await writeFile(path.join(projectsRoot, "proc", "simulation", "results.csv"), "x", "utf8");
    const okSim = await handlers.advance_engineering_stage?.({ project_name: "proc", stage: "simulation" });
    expect(okSim?.isError).toBeFalsy();
  });
});

describe("multidisciplinary — satisfied by any one family", () => {
  it("advances once any single family's evidence exists, without requiring all three", async () => {
    await scaffold("hybrid", "multidisciplinary");
    const { handlers } = workflow();

    const blocked = await handlers.advance_engineering_stage?.({ project_name: "hybrid", stage: "cad" });
    expect(blocked?.isError).toBe(true);

    // Only the electrical family's requirement is met.
    await writeFile(path.join(projectsRoot, "hybrid", "cad", "board.kicad_sch"), "x", "utf8");
    const ok = await handlers.advance_engineering_stage?.({ project_name: "hybrid", stage: "cad" });
    expect(ok?.isError).toBeFalsy();
  });
});

describe("regression: the un-awaited readdir bug", () => {
  it("does NOT report evidence as ready just because the folder exists — it must actually check the file extensions inside", async () => {
    await scaffold("empty-folder", "mechanical");
    const { handlers } = workflow();
    // The cad/ folder already exists (create_engineering_project makes it)
    // but has nothing in it yet except cad/README.md, which the mechanical
    // family's extensions (.fcstd/.step/.stp) don't match. The old buggy
    // version treated "folder exists" as "evidence present" — this must not.
    const result = await handlers.advance_engineering_stage?.({ project_name: "empty-folder", stage: "cad" });
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/missing evidence/i);
  });
});

describe("discipline persistence and fallback", () => {
  it("a project created with a discipline resolves it back on inspect without re-declaring it", async () => {
    await scaffold("known-disc", "electrical");
    const { handlers } = workflow();
    const result = await handlers.inspect_engineering_workflow?.({ project_name: "known-disc" });
    expect(result?.content).toContain('"discipline": "electrical"');
  });

  it("falls back to parsing README.md's discipline line for a project with no engineering-status.json at all", async () => {
    const root = path.join(projectsRoot, "legacy-project");
    await mkdir(path.join(root, "cad"), { recursive: true });
    await mkdir(path.join(root, "simulation"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# legacy-project\n\nPrimary discipline: electrical.\n", "utf8");
    await writeFile(path.join(root, "requirements.md"), "# Requirements\n", "utf8");
    await writeFile(path.join(root, "cad", "board.kicad_sch"), "x", "utf8");

    const { handlers } = workflow();
    const result = await handlers.advance_engineering_stage?.({ project_name: "legacy-project", stage: "cad" });
    expect(result?.isError).toBeFalsy();
  });

  it("defaults to multidisciplinary when neither a status file nor a readable README discipline line exists", async () => {
    const root = path.join(projectsRoot, "no-metadata");
    await mkdir(path.join(root, "cad"), { recursive: true });
    await writeFile(path.join(root, "requirements.md"), "# Requirements\n", "utf8");
    // No README.md at all.
    await writeFile(path.join(root, "cad", "board.kicad_sch"), "x", "utf8");

    const { handlers } = workflow();
    // multidisciplinary accepts the electrical family's evidence too.
    const result = await handlers.advance_engineering_stage?.({ project_name: "no-metadata", stage: "cad" });
    expect(result?.isError).toBeFalsy();
  });

  it("writeInitialEngineeringStatus persists exactly the given discipline", async () => {
    const root = path.join(projectsRoot, "direct-status");
    await mkdir(root, { recursive: true });
    await writeInitialEngineeringStatus(root, "chemical");
    const { handlers } = workflow();
    const result = await handlers.inspect_engineering_workflow?.({ project_name: "direct-status" });
    expect(result?.content).toContain('"discipline": "chemical"');
  });
});
