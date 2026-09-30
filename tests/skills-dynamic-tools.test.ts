import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSkillsToolset } from "../src/main/skills/tools.js";
import { buildDynamicSkillTools } from "../src/main/skills/dynamicTools.js";
import { readSkillManifest, writeSkillManifest } from "../src/main/skills/manifest.js";
import type { PythonRunResult } from "../src/shared/types.js";

let skillsRoot: string;

beforeEach(async () => {
  skillsRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-dynamic-tools-test-"));
});

afterEach(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
});

// A fake runPython that proves args actually arrived, instead of just
// echoing the code back — the specific thing a fixed run_skill call could
// never do.
const echoArgsRunPython = async (_code: string, args?: Record<string, unknown>): Promise<PythonRunResult> => ({
  stdout: "",
  result: JSON.stringify(args ?? {}),
  error: null
});

describe("manifest round-trip", () => {
  it("writes and reads back the same parameters and capabilities", async () => {
    await writeSkillManifest(skillsRoot, "resistor_color_code", {
      parameters: { properties: { bands: { type: "array" } }, required: ["bands"] },
      capabilities: ["read_project_file"]
    });
    const manifest = await readSkillManifest(skillsRoot, "resistor_color_code");
    expect(manifest).toEqual({
      parameters: { properties: { bands: { type: "array" } }, required: ["bands"] },
      capabilities: ["read_project_file"]
    });
  });

  it("returns null for a skill with no manifest file at all", async () => {
    const manifest = await readSkillManifest(skillsRoot, "no_manifest_here");
    expect(manifest).toBeNull();
  });
});

describe("create_skill with parameters", () => {
  it("accepts a valid parameter schema, writes a manifest, and does not run verification yet", async () => {
    let runPythonCalls = 0;
    const countingRunPython = async (): Promise<PythonRunResult> => {
      runPythonCalls++;
      return { stdout: "", result: null, error: null };
    };
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: countingRunPython });

    const result = await handlers.create_skill?.({
      name: "voltage_divider",
      description: "Computes Vout for a resistive divider.",
      code: "print(args['vin'] * args['r2'] / (args['r1'] + args['r2']))",
      parameters: {
        properties: {
          vin: { type: "number" },
          r1: { type: "number" },
          r2: { type: "number" }
        },
        required: ["vin", "r1", "r2"]
      }
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.content).toContain("skill_voltage_divider");
    // The whole point: a skill needing real args can't be honestly
    // verified with none, so create_skill must not have run it.
    expect(runPythonCalls).toBe(0);

    const manifest = await readSkillManifest(skillsRoot, "voltage_divider");
    expect(manifest?.parameters?.required).toEqual(["vin", "r1", "r2"]);
  });

  it("rejects a malformed parameters argument instead of silently ignoring it", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    const result = await handlers.create_skill?.({
      name: "bad_params",
      description: "d",
      code: "pass",
      parameters: { required: ["x"] } // missing required "properties"
    });
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/properties/i);
  });

  it("re-saving a skill without parameters clears a previous manifest", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    await handlers.create_skill?.({
      name: "flip_flop",
      description: "v1, parameterized",
      code: "pass",
      parameters: { properties: { x: { type: "number" } } }
    });
    expect((await readSkillManifest(skillsRoot, "flip_flop"))?.parameters).toBeDefined();

    await handlers.create_skill?.({ name: "flip_flop", description: "v2, plain", code: "print('plain')" });
    expect(await readSkillManifest(skillsRoot, "flip_flop")).toBeNull();
  });
});

describe("buildDynamicSkillTools", () => {
  it("projects a parameterized skill as its own tool named skill_<name>, with the declared schema", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    await handlers.create_skill?.({
      name: "resistor_color_code",
      description: "Decodes a 4-band resistor color code into ohms.",
      code: "pass",
      parameters: {
        properties: { bands: { type: "array", items: { type: "string" } } },
        required: ["bands"]
      }
    });

    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: echoArgsRunPython });
    expect(dynamic.defs).toHaveLength(1);
    expect(dynamic.defs[0]).toMatchObject({
      name: "skill_resistor_color_code",
      description: "Decodes a 4-band resistor color code into ohms.",
      inputSchema: {
        type: "object",
        properties: { bands: { type: "array", items: { type: "string" } } },
        required: ["bands"]
      }
    });
    expect(Object.keys(dynamic.handlers)).toEqual(["skill_resistor_color_code"]);
  });

  it("does not project a skill saved without parameters — it stays run_skill-only", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    await handlers.create_skill?.({ name: "plain_skill", description: "d", code: "print('hi')" });

    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: echoArgsRunPython });
    expect(dynamic.defs).toHaveLength(0);
  });

  it("calling the projected tool threads the bound arguments through to the sandbox", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    await handlers.create_skill?.({
      name: "adder",
      description: "Adds two numbers.",
      code: "print(args['a'] + args['b'])",
      parameters: { properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }
    });

    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: echoArgsRunPython });
    const result = await dynamic.handlers.skill_adder?.({ a: 2, b: 3 });
    expect(result?.isError).toBeFalsy();
    // echoArgsRunPython reflects exactly what it received as `args` back as
    // its "result" — proving the real arguments (not the fixed code, not
    // nothing) made it all the way from the tool call to runPython.
    expect(result?.content).toContain('"a":2');
    expect(result?.content).toContain('"b":3');
  });

  it("records a real pass/fail verification the first time the projected tool is actually called", async () => {
    const failingRunPython = async (): Promise<PythonRunResult> => ({ stdout: "", result: null, error: "KeyError: 'missing'" });
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: failingRunPython });
    await handlers.create_skill?.({
      name: "picky",
      description: "d",
      code: "args['missing']",
      parameters: { properties: {} }
    });

    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: failingRunPython });
    const result = await dynamic.handlers.skill_picky?.({});
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("KeyError");
  });

  it("reports a clear error rather than crashing when a projected skill's directory has since been deleted", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    await handlers.create_skill?.({
      name: "temp_skill",
      description: "d",
      code: "pass",
      parameters: { properties: {} }
    });
    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: echoArgsRunPython });
    await rm(path.join(skillsRoot, "temp_skill"), { recursive: true, force: true });

    const result = await dynamic.handlers.skill_temp_skill?.({});
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/no longer exists/i);
  });

  it("returns an empty toolset for a skills root that doesn't exist yet, rather than throwing", async () => {
    const dynamic = await buildDynamicSkillTools({
      skillsRoot: path.join(skillsRoot, "does-not-exist"),
      runPython: echoArgsRunPython
    });
    expect(dynamic.defs).toEqual([]);
    expect(dynamic.handlers).toEqual({});
  });
});

describe("create_skill with capabilities", () => {
  it("accepts declared capabilities from the fixed set and writes them to the manifest", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    const result = await handlers.create_skill?.({
      name: "note_writer",
      description: "Writes a note to the Projects folder.",
      code: "pass",
      capabilities: ["write_project_file"]
    });
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toContain("write_project_file");

    const manifest = await readSkillManifest(skillsRoot, "note_writer");
    expect(manifest?.capabilities).toEqual(["write_project_file"]);
  });

  it("rejects an unknown capability name instead of silently accepting it", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: echoArgsRunPython });
    const result = await handlers.create_skill?.({
      name: "bad_capability",
      description: "d",
      code: "pass",
      capabilities: ["run_python"] // not a real host capability — it's the sandbox bridge itself
    });
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/unknown capabilit/i);
  });

  it("a zero-argument skill with capabilities is still verified immediately, with those capabilities available", async () => {
    let receivedCapabilities: string[] | undefined;
    const capturingRunPython = async (_code: string, _args?: Record<string, unknown>, capabilities?: string[]): Promise<PythonRunResult> => {
      receivedCapabilities = capabilities;
      return { stdout: "", result: null, error: null };
    };
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: capturingRunPython });
    const result = await handlers.create_skill?.({
      name: "logger",
      description: "Always logs to a fixed file.",
      code: "pass",
      capabilities: ["write_project_file"]
    });
    expect(result?.content).toMatch(/verified/i);
    expect(receivedCapabilities).toEqual(["write_project_file"]);
  });
});

describe("buildDynamicSkillTools with capabilities", () => {
  it("threads a parameterized skill's declared capabilities through to runPython on every call", async () => {
    let receivedCapabilities: string[] | undefined;
    const capturingRunPython = async (_code: string, _args?: Record<string, unknown>, capabilities?: string[]): Promise<PythonRunResult> => {
      receivedCapabilities = capabilities;
      return { stdout: "", result: null, error: null };
    };
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: capturingRunPython });
    await handlers.create_skill?.({
      name: "project_note",
      description: "Saves a note.",
      code: "pass",
      parameters: { properties: { text: { type: "string" } }, required: ["text"] },
      capabilities: ["write_project_file", "read_project_file"]
    });

    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: capturingRunPython });
    await dynamic.handlers.skill_project_note?.({ text: "hello" });
    expect(receivedCapabilities).toEqual(["write_project_file", "read_project_file"]);
  });

  it("a skill with no declared capabilities gets an empty list, not undefined — the mimir object simply won't exist", async () => {
    let receivedCapabilities: string[] | undefined;
    const capturingRunPython = async (_code: string, _args?: Record<string, unknown>, capabilities?: string[]): Promise<PythonRunResult> => {
      receivedCapabilities = capabilities;
      return { stdout: "", result: null, error: null };
    };
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: capturingRunPython });
    await handlers.create_skill?.({
      name: "pure_math",
      description: "Just computes.",
      code: "pass",
      parameters: { properties: { x: { type: "number" } } }
    });

    const dynamic = await buildDynamicSkillTools({ skillsRoot, runPython: capturingRunPython });
    await dynamic.handlers.skill_pure_math?.({ x: 1 });
    expect(receivedCapabilities).toEqual([]);
  });
});
