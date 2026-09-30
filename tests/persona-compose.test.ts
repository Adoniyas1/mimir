import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildComposedSystemPrompt, isBootstrapPending } from "../src/main/persona/compose.js";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-persona-test-"));
  await mkdir(path.join(workspaceRoot, "persona"), { recursive: true });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("persona compose", () => {
  it("treats a workspace with a blank IDENTITY.md as bootstrap-pending", async () => {
    await writeFile(path.join(workspaceRoot, "persona", "IDENTITY.md"), "", "utf-8");
    expect(await isBootstrapPending(workspaceRoot)).toBe(true);

    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).toContain("You don't have an identity yet");
    expect(prompt).not.toContain("# Your identity (IDENTITY.md)");
  });

  it("uses a compact, tool-free system prompt for small local conversations", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, {
      memoryMaxChars: 0,
      dailyLogDays: 0,
      includeToolInstructions: false
    });

    expect(prompt).toContain("Never claim to change files");
    expect(prompt).not.toContain("propose_edit is ONLY");
  });

  it("adds only the supplied focused action to a compact local prompt", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, {
      memoryMaxChars: 0,
      dailyLogDays: 0,
      includeToolInstructions: false,
      localToolInstructions: "You have one available action: create a cable guide."
    });

    expect(prompt).toContain("create a cable guide");
    expect(prompt).not.toContain("propose_edit is ONLY");
    expect(prompt).not.toContain("run_python");
  });

  it("keeps persona documents out of a task-first local prompt", async () => {
    await writeFile(path.join(workspaceRoot, "persona", "IDENTITY.md"), "# Identity\n\nI am very elaborate.\n", "utf-8");
    await writeFile(path.join(workspaceRoot, "persona", "SOUL.md"), "# Soul\n\nDiscuss my personality.\n", "utf-8");
    await writeFile(path.join(workspaceRoot, "persona", "USER.md"), "# User\n\nPrivate profile text.\n", "utf-8");

    const prompt = await buildComposedSystemPrompt(workspaceRoot, {
      includeToolInstructions: true,
      includePersonaDocuments: false,
      memoryMaxChars: 0,
      dailyLogDays: 0
    });

    expect(prompt).not.toContain("very elaborate");
    expect(prompt).not.toContain("Discuss my personality");
    expect(prompt).not.toContain("Private profile text");
    expect(prompt).not.toContain("You don't have an identity yet");
  });

  it("treats a workspace with a filled-in IDENTITY.md as no longer bootstrap-pending", async () => {
    await writeFile(
      path.join(workspaceRoot, "persona", "IDENTITY.md"),
      "# Identity\n\nI'm Mimir, direct and a little dry.\n",
      "utf-8"
    );
    expect(await isBootstrapPending(workspaceRoot)).toBe(false);

    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).not.toContain("You don't have an identity yet");
    expect(prompt).toContain("# Your identity (IDENTITY.md)");
    expect(prompt).toContain("direct and a little dry");
  });

  it("still composes a usable prompt when persona/ has no files at all yet", async () => {
    // No IDENTITY.md written — exercises the "file doesn't exist" path, not just "empty file".
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).toContain("You don't have an identity yet");
    expect(await isBootstrapPending(workspaceRoot)).toBe(true);
  });

  it("never tells a tool-less local model to call identity_replace, even with a blank identity", async () => {
    // Regression test for the bug fix in compose.ts: this used to be pushed
    // unconditionally, producing a prompt that told a tool-less model to
    // call a tool it doesn't have — the same failure mode as the original
    // hallucinated-JSON-in-chat bug report.
    const prompt = await buildComposedSystemPrompt(workspaceRoot, { includeToolInstructions: false });
    expect(prompt).not.toContain("You don't have an identity yet");
    expect(prompt).not.toContain("identity_replace");
  });

  it("injects TASKS.md as an upcoming-deadlines section when it has content", async () => {
    await writeFile(
      path.join(workspaceRoot, "persona", "TASKS.md"),
      "- Problem set 3 — due Thursday\n",
      "utf-8"
    );
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).toContain("# Upcoming deadlines and tasks (TASKS.md)");
    expect(prompt).toContain("Problem set 3");
  });

  it("omits the TASKS.md section entirely when there are no tasks", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).not.toContain("Upcoming deadlines and tasks");
  });

  it("gives a model with tools but no self-edit the lightweight tool vocabulary, minus propose_edit", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, {
      includeToolInstructions: true,
      includeSelfEditInstructions: false
    });
    // Lightweight tools (memory, tasks, projects, compute, skills) are
    // still there — this is the "give itself skills" capability available
    // to every model.
    expect(prompt).toContain("memory_replace");
    expect(prompt).toContain("tasks_replace");
    expect(prompt).toContain("run_python");
    expect(prompt).toContain("write_project_file");
    expect(prompt).toContain("create_skill");
    // But source-code self-editing, the one capability with live-tested
    // evidence of confusing a small local model, is omitted entirely.
    expect(prompt).not.toContain("propose_edit");
  });

  it("includes propose_edit instructions when self-edit is enabled (the default)", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot);
    expect(prompt).toContain("propose_edit is ONLY for source code");
  });

  it("gives a core-tier turn a short, exact tool list instead of the full paragraphs", async () => {
    const prompt = await buildComposedSystemPrompt(workspaceRoot, {
      includeToolInstructions: true,
      includeSelfEditInstructions: false,
      includePersonaDocuments: false,
      toolTier: "core"
    });
    // The tools core tier actually has:
    expect(prompt).toContain("run_python");
    expect(prompt).toContain("create_skill");
    expect(prompt).toContain("memory_replace");
    expect(prompt).toContain("write_project_file");
    // Tools it does NOT have — describing these is exactly what produced
    // the hallucinated-tool-call-JSON bug this tiering exists to prevent.
    expect(prompt).not.toContain("propose_edit");
    expect(prompt).not.toContain("soul_replace");
    expect(prompt).not.toContain("export_to_pdf");
    expect(prompt).not.toContain("tasks_replace");
    expect(prompt).not.toContain("semantic_search_project_files");
  });

  it("core tier still identifies Mimir and gives real, positive tool instructions (not a tool-free prompt)", async () => {
    const corePrompt = await buildComposedSystemPrompt(workspaceRoot, {
      includeToolInstructions: true,
      toolTier: "core"
    });
    expect(corePrompt).toContain("You are Mimir");
    expect(corePrompt).toContain("curated set of tools");
    expect(corePrompt).not.toContain("You have no available actions");
  });
});
