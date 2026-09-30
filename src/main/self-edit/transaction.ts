import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { resolveConfinedPath } from "./pathGuard.js";
import { AuditLog } from "./audit.js";
import type { AuditEntry, EditTier } from "../../shared/types.js";

const execAsync = promisify(exec);

export interface FileWrite {
  /** Path relative to the workspace root. */
  path: string;
  content: string;
}

export interface VerifyStep {
  name: string;
  /** Shell command, run with cwd = workspace root. */
  command: string;
  timeoutMs?: number;
}

export interface TransactionOptions {
  summary: string;
  tier: EditTier;
  writes: FileWrite[];
  verifySteps: VerifyStep[];
}

export type TransactionResult =
  | {
      status: "applied";
      commitSha: string;
      parentSha: string;
      auditId: string;
      filesTouched: string[];
    }
  | {
      status: "rejected";
      reason: "dirty-working-tree" | "no-writes";
      detail: string;
    }
  | {
      status: "rolled-back";
      parentSha: string;
      failedStep: string;
      stepOutput: string;
    };

/**
 * The core safety mechanism of Mimir. Every self-edit — whether to a
 * hot-reloadable skill or to Mimir's own core source — goes through this
 * exact sequence:
 *
 *   1. Record the current commit as the rollback anchor (`parentSha`).
 *   2. Apply the proposed file writes, confined to the workspace root.
 *   3. Run the verify pipeline (typecheck, lint, tests — caller-supplied,
 *      so tests can inject a cheap fake pipeline).
 *   4. On any failure: `git reset --hard` + `git clean -fd` back to
 *      `parentSha`. The working tree ends up byte-identical to before the
 *      transaction started — nothing partially-applied survives.
 *   5. On success: commit, and append an AuditEntry the user can browse
 *      and revert from later (see audit.ts).
 *
 * This class knows nothing about Electron, Claude, or the agent loop — it
 * operates on any git-controlled directory, which is what makes it
 * directly unit-testable (see tests/transaction.test.ts).
 */
export class SelfEditTransaction {
  private git: SimpleGit;
  private audit: AuditLog;

  constructor(
    private workspaceRoot: string,
    auditFilePath: string
  ) {
    this.git = simpleGit(workspaceRoot);
    this.audit = new AuditLog(auditFilePath);
  }

  async run(opts: TransactionOptions): Promise<TransactionResult> {
    if (opts.writes.length === 0) {
      return { status: "rejected", reason: "no-writes", detail: "No files to write." };
    }

    const status = await this.git.status();
    if (!status.isClean()) {
      return {
        status: "rejected",
        reason: "dirty-working-tree",
        detail:
          "Workspace has uncommitted changes outside of a transaction — refusing to start a new one until it's clean."
      };
    }

    const parentSha = await this.git.revparse(["HEAD"]);

    // Resolve + validate every path up front, before writing anything.
    const resolvedWrites = opts.writes.map((w) => ({
      absolute: resolveConfinedPath(this.workspaceRoot, w.path),
      relative: w.path,
      content: w.content
    }));

    for (const w of resolvedWrites) {
      await mkdir(path.dirname(w.absolute), { recursive: true });
      await writeFile(w.absolute, w.content, "utf-8");
    }

    for (const step of opts.verifySteps) {
      const result = await runVerifyStep(this.workspaceRoot, step);
      if (!result.ok) {
        await this.git.reset(["--hard", parentSha]);
        await this.git.clean("fd");
        return {
          status: "rolled-back",
          parentSha,
          failedStep: step.name,
          stepOutput: result.output
        };
      }
    }

    await this.git.add(["-A"]);
    const filesTouched = resolvedWrites.map((w) => w.relative);
    const commitMessage = [
      `mimir: ${opts.summary}`,
      "",
      `Tier: ${opts.tier}`,
      `Files: ${filesTouched.join(", ")}`
    ].join("\n");
    await this.git.commit(commitMessage);
    const commitSha = await this.git.revparse(["HEAD"]);

    const entry: AuditEntry = {
      id: cryptoRandomId(),
      commitSha,
      parentSha,
      summary: opts.summary,
      tier: opts.tier,
      filesTouched,
      appliedAt: Date.now(),
      status: "applied"
    };
    await this.audit.append(entry);

    return { status: "applied", commitSha, parentSha, auditId: entry.id, filesTouched };
  }

  /** Revert a previously-applied transaction by its audit entry id. */
  async revert(auditId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const entry = await this.audit.get(auditId);
    if (!entry) return { ok: false, error: `No audit entry with id ${auditId}` };
    if (entry.status === "reverted") return { ok: false, error: "Already reverted." };

    const head = await this.git.revparse(["HEAD"]);
    try {
      if (head.trim() === entry.commitSha.trim()) {
        // Fast path: reverting the most recent transaction — just roll back to its parent.
        await this.git.reset(["--hard", entry.parentSha]);
      } else {
        // An older transaction — undo it in place without disturbing later commits.
        await this.git.revert(entry.commitSha, { "--no-edit": null });
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await this.audit.markReverted(auditId);
    return { ok: true };
  }

  listAudit(): Promise<AuditEntry[]> {
    return this.audit.list();
  }
}

async function runVerifyStep(
  cwd: string,
  step: VerifyStep
): Promise<{ ok: true } | { ok: false; output: string }> {
  try {
    await execAsync(step.command, {
      cwd,
      timeout: step.timeoutMs ?? 60_000,
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
    return { ok: false, output: output || "Verify step failed with no output." };
  }
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
