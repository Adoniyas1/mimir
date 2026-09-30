import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { SelfEditTransaction } from "../src/main/self-edit/transaction.js";
import { PathEscapeError } from "../src/main/self-edit/pathGuard.js";

let workspaceRoot: string;
let auditFile: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-test-"));
  auditFile = path.join(workspaceRoot, "..", `audit-${path.basename(workspaceRoot)}.json`);

  await writeFile(path.join(workspaceRoot, "README.md"), "# test workspace\n", "utf-8");
  const git = simpleGit(workspaceRoot);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@localhost");
  await git.add(["-A"]);
  await git.commit("initial commit");
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(auditFile, { force: true });
});

describe("SelfEditTransaction", () => {
  it("applies a change and commits it when verify passes", async () => {
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);
    const git = simpleGit(workspaceRoot);
    const before = await git.revparse(["HEAD"]);

    const result = await tx.run({
      summary: "add a greeting file",
      tier: "skill",
      writes: [{ path: "greeting.txt", content: "hello from mimir\n" }],
      verifySteps: [{ name: "always-pass", command: "true" }]
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");

    const after = await git.revparse(["HEAD"]);
    expect(after).not.toBe(before);
    expect(result.commitSha.trim()).toBe(after.trim());

    const content = await readFile(path.join(workspaceRoot, "greeting.txt"), "utf-8");
    expect(content).toBe("hello from mimir\n");

    const audit = await tx.listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe("applied");
    expect(audit[0]?.filesTouched).toEqual(["greeting.txt"]);
  });

  it("rolls back to the checkpoint when a verify step fails, leaving no trace", async () => {
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);
    const git = simpleGit(workspaceRoot);
    const before = await git.revparse(["HEAD"]);

    const result = await tx.run({
      summary: "a change that should never land",
      tier: "core",
      writes: [{ path: "broken.txt", content: "this should not survive\n" }],
      verifySteps: [
        { name: "always-pass", command: "true" },
        { name: "always-fail", command: "false" }
      ]
    });

    expect(result.status).toBe("rolled-back");
    if (result.status !== "rolled-back") throw new Error("unreachable");
    expect(result.failedStep).toBe("always-fail");

    // HEAD is unchanged — no bad commit was ever created.
    const after = await git.revparse(["HEAD"]);
    expect(after.trim()).toBe(before.trim());

    // The working tree has no trace of the rejected write, tracked or not.
    expect(existsSync(path.join(workspaceRoot, "broken.txt"))).toBe(false);

    const status = await git.status();
    expect(status.isClean()).toBe(true);

    // Nothing was audited — the edit never applied.
    const audit = await tx.listAudit();
    expect(audit).toHaveLength(0);
  });

  it("refuses a path that escapes the workspace root", async () => {
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);
    await expect(
      tx.run({
        summary: "path traversal attempt",
        tier: "skill",
        writes: [{ path: "../outside.txt", content: "escape\n" }],
        verifySteps: [{ name: "always-pass", command: "true" }]
      })
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("refuses to start a new transaction while the working tree is dirty", async () => {
    await writeFile(path.join(workspaceRoot, "untracked.txt"), "uncommitted\n", "utf-8");
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);

    const result = await tx.run({
      summary: "should be rejected",
      tier: "skill",
      writes: [{ path: "another.txt", content: "x\n" }],
      verifySteps: [{ name: "always-pass", command: "true" }]
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.reason).toBe("dirty-working-tree");
  });

  it("can revert the most recent applied transaction back to its parent commit", async () => {
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);
    const git = simpleGit(workspaceRoot);
    const before = await git.revparse(["HEAD"]);

    const applied = await tx.run({
      summary: "temporary change",
      tier: "skill",
      writes: [{ path: "temp.txt", content: "temporary\n" }],
      verifySteps: [{ name: "always-pass", command: "true" }]
    });
    if (applied.status !== "applied") throw new Error("setup failed: " + JSON.stringify(applied));

    const reverted = await tx.revert(applied.auditId);
    expect(reverted.ok).toBe(true);

    const after = await git.revparse(["HEAD"]);
    expect(after.trim()).toBe(before.trim());
    expect(existsSync(path.join(workspaceRoot, "temp.txt"))).toBe(false);

    const audit = await tx.listAudit();
    expect(audit.find((e) => e.id === applied.auditId)?.status).toBe("reverted");
  });

  it("nested directories: creates parent directories for new files", async () => {
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);
    const result = await tx.run({
      summary: "add a skill in a subdirectory",
      tier: "skill",
      writes: [{ path: path.join("skills", "weather.ts"), content: "export default function weather() {}\n" }],
      verifySteps: [{ name: "always-pass", command: "true" }]
    });
    expect(result.status).toBe("applied");
    expect(existsSync(path.join(workspaceRoot, "skills", "weather.ts"))).toBe(true);
  });

  it("applies a persona-tier edit instantly with an empty verify pipeline, and audits it as 'persona'", async () => {
    const tx = new SelfEditTransaction(workspaceRoot, auditFile);
    const git = simpleGit(workspaceRoot);
    const before = await git.revparse(["HEAD"]);

    const result = await tx.run({
      summary: "Update MEMORY.md",
      tier: "persona",
      writes: [{ path: path.join("persona", "MEMORY.md"), content: "The user prefers dark mode.\n" }],
      verifySteps: [] // persona edits are markdown-only — nothing to gate, matches verifyPresets.PERSONA_VERIFY_STEPS
    });

    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");

    const after = await git.revparse(["HEAD"]);
    expect(after).not.toBe(before);

    const content = await readFile(path.join(workspaceRoot, "persona", "MEMORY.md"), "utf-8");
    expect(content).toBe("The user prefers dark mode.\n");

    const audit = await tx.listAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tier).toBe("persona");
    expect(audit[0]?.status).toBe("applied");
  });
});
