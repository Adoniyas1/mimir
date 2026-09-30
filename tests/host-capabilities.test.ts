import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HOST_CAPABILITY_NAMES,
  buildHostCapabilityDispatch,
  isCapabilityDeclaredForRun,
  isHostCapabilityName
} from "../src/main/compute/hostCapabilities.js";

describe("isHostCapabilityName", () => {
  it("accepts exactly the fixed, documented capability names", () => {
    for (const name of HOST_CAPABILITY_NAMES) {
      expect(isHostCapabilityName(name)).toBe(true);
    }
  });

  it("rejects tools that could escalate or deadlock the sandbox — the whole reason this allowlist is fixed, not dynamic", () => {
    // run_python/run_skill/verify_skill: a skill calling back into the
    // Python bridge would try to re-enter the single-threaded worker that's
    // already awaiting it — a deadlock, not a permissions question.
    // propose_edit and every self-edit/mac tool: the actual escalation
    // paths this whole capability model exists to keep a skill away from.
    for (const name of ["run_python", "run_skill", "verify_skill", "create_skill", "propose_edit", "read_file", "list_files", "search", "open_engineering_app", "reveal_project_file"]) {
      expect(isHostCapabilityName(name)).toBe(false);
    }
  });

  it("rejects an unknown or misspelled name rather than matching loosely", () => {
    expect(isHostCapabilityName("write_project_files")).toBe(false); // plural typo
    expect(isHostCapabilityName("")).toBe(false);
  });
});

describe("isCapabilityDeclaredForRun", () => {
  it("requires the name to be both a real capability AND declared for this specific run", () => {
    expect(isCapabilityDeclaredForRun("write_project_file", ["write_project_file", "read_project_file"])).toBe(true);
    // Real capability, but not one *this* skill declared — one skill's
    // capabilities must never leak to a different skill's run.
    expect(isCapabilityDeclaredForRun("write_project_file", ["read_project_file"])).toBe(false);
    // Declared by the caller, but not a real capability at all — the fixed
    // allowlist wins even if a run somehow claims otherwise.
    expect(isCapabilityDeclaredForRun("propose_edit", ["propose_edit"])).toBe(false);
  });

  it("declares nothing by default (an empty list) — a skill with no capabilities can call none", () => {
    expect(isCapabilityDeclaredForRun("write_project_file", [])).toBe(false);
  });
});

describe("buildHostCapabilityDispatch", () => {
  let projectsRoot: string;

  beforeEach(async () => {
    projectsRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-host-capabilities-test-"));
  });

  afterEach(async () => {
    await rm(projectsRoot, { recursive: true, force: true });
  });

  it("dispatches write_project_file through the real, confined projects handler — an actual file lands on disk", async () => {
    const dispatch = buildHostCapabilityDispatch(projectsRoot);
    const result = await dispatch("write_project_file", { path: "notes/from-a-skill.md", content: "hello from a skill" });
    expect(result.isError).toBeFalsy();
    expect(await readFile(path.join(projectsRoot, "notes", "from-a-skill.md"), "utf-8")).toBe("hello from a skill");
  });

  it("dispatches read_project_file and list_project_files through the same real handlers", async () => {
    const dispatch = buildHostCapabilityDispatch(projectsRoot);
    await dispatch("write_project_file", { path: "a.txt", content: "content-a" });

    const read = await dispatch("read_project_file", { path: "a.txt" });
    expect(read.content).toBe("content-a");

    const listed = await dispatch("list_project_files", {});
    expect(listed.content).toContain("a.txt");
  });

  it("confinement is inherited for free from buildProjectsToolset — a path escape is still rejected", async () => {
    const dispatch = buildHostCapabilityDispatch(projectsRoot);
    const result = await dispatch("write_project_file", { path: "../../escape.txt", content: "x" });
    expect(result.isError).toBe(true);
  });

  it("refuses to dispatch a name outside the fixed capability set, even if asked to", async () => {
    const dispatch = buildHostCapabilityDispatch(projectsRoot);
    const result = await dispatch("propose_edit", { summary: "x", tier: "skill", files: [] });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a capability/i);
  });
});
