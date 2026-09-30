import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDef, Toolset } from "../brain/Provider.js";
import type { PendingEdit } from "../../shared/types.js";
import { resolveConfinedPath } from "./pathGuard.js";
import { SelfEditTransaction } from "./transaction.js";
import { SKILL_VERIFY_STEPS, CORE_VERIFY_STEPS } from "./verifyPresets.js";

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "dist-installers"]);

/** Something that can pause a core-tier edit for human sign-off. Backed by
 * IPC + a renderer approval UI in the real app; a fake in tests. */
export interface EditApprovalGate {
  requestApproval(pending: PendingEdit): Promise<"approved" | "rejected">;
}

export interface SelfEditToolsetOptions {
  workspaceRoot: string;
  transaction: SelfEditTransaction;
  gate: EditApprovalGate;
  getAutoApproveCoreEdits: () => boolean | Promise<boolean>;
  /** Called after a "core" tier edit is applied, so the app can restart into it. */
  onCoreEditApplied?: (commitSha: string) => void;
}

export function buildSelfEditToolset(opts: SelfEditToolsetOptions): Toolset {
  const { workspaceRoot, transaction, gate, getAutoApproveCoreEdits, onCoreEditApplied } = opts;

  const defs: ToolDef[] = [
    {
      name: "read_file",
      description: "Read a text file from Mimir's own workspace, by path relative to the workspace root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "list_files",
      description:
        "List files under a directory in Mimir's workspace (relative path; defaults to the root). Skips node_modules/dist/.git.",
      inputSchema: {
        type: "object",
        properties: { dir: { type: "string" } }
      }
    },
    {
      name: "search",
      description: "Search Mimir's workspace source files for a literal or regex substring.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          regex: { type: "boolean" }
        },
        required: ["query"]
      }
    },
    {
      name: "propose_edit",
      description:
        "Propose one or more file writes to Mimir's own source. 'skill' tier is for new/changed capability " +
        "modules under skills/ and applies immediately after a fast typecheck. 'core' tier touches the running " +
        "app itself (src/main, src/renderer) and always requires a full verify pass; unless auto-approve is on, " +
        "it also requires the user's explicit approval before it's applied and the app restarts.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One-line description of the change, for the audit log." },
          tier: { type: "string", enum: ["skill", "core"] },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"]
            }
          }
        },
        required: ["summary", "tier", "files"]
      }
    }
  ];

  const handlers: Toolset["handlers"] = {
    read_file: async (input) => {
      const rel = requireString(input, "path");
      try {
        const abs = resolveConfinedPath(workspaceRoot, rel);
        const content = await readFile(abs, "utf-8");
        return { content };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    list_files: async (input) => {
      const dir = typeof input.dir === "string" ? input.dir : ".";
      try {
        const abs = resolveConfinedPath(workspaceRoot, dir);
        const files = await listRecursive(abs, workspaceRoot);
        return { content: files.join("\n") || "(empty directory)" };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    search: async (input) => {
      const query = requireString(input, "query");
      const useRegex = input.regex === true;
      try {
        const matcher = useRegex ? new RegExp(query) : null;
        const files = await listRecursive(workspaceRoot, workspaceRoot);
        const hits: string[] = [];
        for (const rel of files) {
          if (!/\.(ts|tsx|js|jsx|json|md)$/.test(rel)) continue;
          const abs = path.join(workspaceRoot, rel);
          const text = await readFile(abs, "utf-8").catch(() => "");
          text.split("\n").forEach((line, i) => {
            const found = matcher ? matcher.test(line) : line.includes(query);
            if (found) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
          if (hits.length > 200) break;
        }
        return { content: hits.slice(0, 200).join("\n") || "No matches." };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    propose_edit: async (input) => {
      const summary = requireString(input, "summary");
      const tier = requireString(input, "tier");
      if (tier !== "skill" && tier !== "core") {
        return { content: "tier must be 'skill' or 'core'", isError: true };
      }
      const filesInput = input.files;
      if (!Array.isArray(filesInput) || filesInput.length === 0) {
        return { content: "files must be a non-empty array", isError: true };
      }
      const writes = filesInput.map((f) => {
        const fo = f as { path?: unknown; content?: unknown };
        if (typeof fo.path !== "string" || typeof fo.content !== "string") {
          throw new Error("Each file needs a string path and string content.");
        }
        return { path: fo.path, content: fo.content };
      });

      if (tier === "core" && !(await getAutoApproveCoreEdits())) {
        const pending: PendingEdit = {
          id: globalThis.crypto.randomUUID(),
          summary,
          diff: writes.map((w) => `--- ${w.path} ---\n${w.content}`).join("\n\n"),
          filesTouched: writes.map((w) => w.path),
          tier: "core"
        };
        const decision = await gate.requestApproval(pending);
        if (decision === "rejected") {
          return { content: "User rejected this core edit. Do not retry the same change." };
        }
      }

      const result = await transaction.run({
        summary,
        tier,
        writes,
        verifySteps: tier === "skill" ? SKILL_VERIFY_STEPS : CORE_VERIFY_STEPS
      });

      if (result.status === "applied") {
        if (tier === "core") onCoreEditApplied?.(result.commitSha);
        return {
          content: `Applied and committed as ${result.commitSha.slice(0, 8)}. Files: ${result.filesTouched.join(", ")}.`
        };
      }
      if (result.status === "rolled-back") {
        return {
          content: `Verify step "${result.failedStep}" failed — change was rolled back to ${result.parentSha.slice(0, 8)}.\n\nOutput:\n${result.stepOutput}`,
          isError: true
        };
      }
      return { content: `Edit rejected: ${result.detail}`, isError: true };
    }
  };

  return { defs, handlers };
}

async function listRecursive(dir: string, root: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listRecursive(abs, root, depth + 1)));
    } else {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
