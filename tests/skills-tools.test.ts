import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSkillsToolset, listSkillSummaries, verifySkillNow } from "../src/main/skills/tools.js";
import type { PythonRunResult } from "../src/shared/types.js";

let skillsRoot: string;

beforeEach(async () => {
  skillsRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-skills-test-"));
});

afterEach(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
});

const fakeRunPython = async (code: string): Promise<PythonRunResult> => ({
  stdout: `ran: ${code.trim()}`,
  result: null,
  error: null
});

describe("skills toolset", () => {
  it("creates a skill and lists it with its description", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });

    const createResult = await handlers.create_skill?.({
      name: "resistor_color_code",
      description: "Decodes a 4-band resistor color code into ohms.",
      code: "print('42 ohms')"
    });
    expect(createResult?.isError).toBeFalsy();

    const listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("resistor_color_code");
    expect(listResult?.content).toContain("Decodes a 4-band resistor");
  });

  it("runs a saved skill through the same python bridge as run_python", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "greet", description: "Says hi.", code: "print('hi')" });

    const runResult = await handlers.run_skill?.({ name: "greet" });
    expect(runResult?.isError).toBeFalsy();
    expect(runResult?.content).toContain("ran: print('hi')");
  });

  it("reports a clear error for an unknown skill instead of crashing", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    const result = await handlers.run_skill?.({ name: "nonexistent" });
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/no skill named/i);
  });

  it("rejects an unsafe skill name rather than writing outside the skills root", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    const result = await handlers.create_skill?.({
      name: "../../escape",
      description: "x",
      code: "pass"
    });
    expect(result?.isError).toBe(true);
  });

  it("overwriting a skill by the same name replaces it, versioned", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "greet", description: "v1", code: "print('v1')" });
    await handlers.create_skill?.({ name: "greet", description: "v2", code: "print('v2')" });

    const listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("v2");
    expect(listResult?.content).not.toContain("v1");

    const runResult = await handlers.run_skill?.({ name: "greet" });
    expect(runResult?.content).toContain("v2");
  });

  it("reports no skills yet on a fresh skills root", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    const result = await handlers.list_skills?.({});
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toMatch(/no skills saved yet/i);
  });

  it("verifies a skill on creation and reports pass in the response", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    const result = await handlers.create_skill?.({ name: "greet", description: "Says hi.", code: "print('hi')" });
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toMatch(/verified/i);

    const listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("[passed]");
  });

  it("reports a failed verification honestly instead of claiming success", async () => {
    const failingRunPython = async (): Promise<PythonRunResult> => ({ stdout: "", result: null, error: "NameError: x is not defined" });
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: failingRunPython });

    const createResult = await handlers.create_skill?.({ name: "broken", description: "Doesn't work.", code: "print(x)" });
    expect(createResult?.content).toMatch(/failed verification/i);
    expect(createResult?.content).toContain("NameError");

    const listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("[failed]");
  });

  it("verify_skill re-checks an existing skill on demand", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "greet", description: "Says hi.", code: "print('hi')" });

    const verifyResult = await handlers.verify_skill?.({ name: "greet" });
    expect(verifyResult?.isError).toBeFalsy();
    expect(verifyResult?.content).toMatch(/verified/i);
  });

  it("verify_skill reports an error for an unknown skill", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    const result = await handlers.verify_skill?.({ name: "nonexistent" });
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/no skill named/i);
  });

  it("running a skill also refreshes its verification status", async () => {
    let shouldFail = false;
    const flippingRunPython = async (): Promise<PythonRunResult> =>
      shouldFail ? { stdout: "", result: null, error: "boom" } : { stdout: "ok", result: null, error: null };
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: flippingRunPython });

    await handlers.create_skill?.({ name: "flaky", description: "d", code: "print('ok')" });
    let listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("[passed]");

    shouldFail = true;
    await handlers.run_skill?.({ name: "flaky" });
    listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("[failed]");
  });
});

describe("listSkillSummaries (Skill Tree UI data)", () => {
  it("returns a full structured summary per skill, including code and verification status", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "greet", description: "Says hi.", code: "print('hi')" });

    const summaries = await listSkillSummaries(skillsRoot);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      name: "greet",
      description: "Says hi.",
      code: "print('hi')",
      status: "passed"
    });
    expect(summaries[0]?.verifiedAt).toBeTypeOf("number");
  });

  it("returns an empty array rather than erroring on a skills root that doesn't exist yet", async () => {
    const summaries = await listSkillSummaries(path.join(skillsRoot, "does-not-exist"));
    expect(summaries).toEqual([]);
  });
});

describe("verifySkillNow (Skill Tree UI 'Verify' button)", () => {
  it("re-runs a skill and returns its updated summary", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "greet", description: "Says hi.", code: "print('hi')" });

    const summary = await verifySkillNow(skillsRoot, "greet", fakeRunPython);
    expect(summary).toMatchObject({ name: "greet", status: "passed" });
  });

  it("returns null for a skill that doesn't exist", async () => {
    const summary = await verifySkillNow(skillsRoot, "nonexistent", fakeRunPython);
    expect(summary).toBeNull();
  });
});

describe("skill tree structure (category + builds_on)", () => {
  it("defaults to the General category and no parent when neither is given", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "greet", description: "d", code: "print('hi')" });

    const [summary] = await listSkillSummaries(skillsRoot);
    expect(summary).toMatchObject({ category: "General", parent: null });
  });

  it("records a custom category and a valid builds_on parent", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "plot_function", description: "Plots f(x).", code: "pass", category: "Math" });
    const result = await handlers.create_skill?.({
      name: "linear_fit",
      description: "Fits a line to data.",
      code: "pass",
      category: "Math",
      builds_on: "plot_function"
    });

    expect(result?.content).not.toContain("no skill named");
    const summaries = await listSkillSummaries(skillsRoot);
    const fit = summaries.find((s) => s.name === "linear_fit");
    expect(fit).toMatchObject({ category: "Math", parent: "plot_function" });

    const listResult = await handlers.list_skills?.({});
    expect(listResult?.content).toContain("[Math > plot_function] linear_fit");
    expect(listResult?.content).toContain("[Math] plot_function");
  });

  it("falls back to a root skill and says so when builds_on names a skill that doesn't exist", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    const result = await handlers.create_skill?.({
      name: "orphan",
      description: "d",
      code: "pass",
      builds_on: "nonexistent_parent"
    });

    expect(result?.content).toContain('no skill named "nonexistent_parent"');
    const [summary] = await listSkillSummaries(skillsRoot);
    expect(summary).toMatchObject({ name: "orphan", parent: null });
  });

  it("preserves category and parent across a re-verification (run_skill doesn't reset tree placement)", async () => {
    const { handlers } = buildSkillsToolset({ skillsRoot, runPython: fakeRunPython });
    await handlers.create_skill?.({ name: "root_skill", description: "d", code: "pass", category: "Circuits" });
    await handlers.create_skill?.({
      name: "child_skill",
      description: "d",
      code: "pass",
      category: "Circuits",
      builds_on: "root_skill"
    });

    await handlers.run_skill?.({ name: "child_skill" });
    await handlers.verify_skill?.({ name: "child_skill" });

    const summaries = await listSkillSummaries(skillsRoot);
    const child = summaries.find((s) => s.name === "child_skill");
    expect(child).toMatchObject({ category: "Circuits", parent: "root_skill", status: "passed" });
  });

  it("fills in defaults for a skill saved before category/parent existed (legacy index entry)", async () => {
    // Simulates a real skill created before this feature shipped: its
    // index entry has status/verifiedAt/error but no category/parent key
    // at all, not even undefined-but-present — a plain older JSON blob.
    const dir = path.join(skillsRoot, "legacy_skill");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "skill.py"), "print('legacy')", "utf-8");
    await writeFile(path.join(dir, "SKILL.md"), "# legacy_skill\n\nAn old one.\n", "utf-8");
    await writeFile(
      path.join(skillsRoot, ".mimir-index.json"),
      JSON.stringify({ legacy_skill: { status: "passed", verifiedAt: 123, error: null } }),
      "utf-8"
    );

    const summaries = await listSkillSummaries(skillsRoot);
    expect(summaries[0]).toMatchObject({ name: "legacy_skill", category: "General", parent: null, status: "passed" });
  });
});
