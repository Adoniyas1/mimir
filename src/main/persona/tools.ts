import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ToolDef, ToolResult, Toolset } from "../brain/Provider.js";
import type { SelfEditTransaction } from "../self-edit/transaction.js";
import { PERSONA_VERIFY_STEPS } from "../self-edit/verifyPresets.js";
import {
  DAILY_LOG_LINE_MAX_CHARS,
  MEMORY_FILE_MAX_BYTES,
  PERSONA_MARKDOWN_MAX_BYTES,
  SOUL_FILE_MAX_BYTES
} from "./templates.js";
import { dailyLogRelativePath, personaFilePath, personaRelativePath, todayISO } from "./paths.js";

export interface PersonaToolsetOptions {
  workspaceRoot: string;
  transaction: SelfEditTransaction;
}

/**
 * Personality/memory tools. All apply instantly (no approval gate, tier
 * "persona" has an empty verify pipeline) — memory-forming should never
 * require a click, and every change still lands in the same git-backed
 * audit log as everything else, so it's trivially revertable if it goes
 * wrong.
 */
export function buildPersonaToolset(opts: PersonaToolsetOptions): Toolset {
  const { workspaceRoot, transaction } = opts;

  const replaceFile = async (
    file: string,
    markdown: string,
    maxBytes: number,
    summary: string
  ): Promise<ToolResult> => {
    const bytes = Buffer.byteLength(markdown, "utf-8");
    if (bytes > maxBytes) {
      return {
        content: `${file} would be ${bytes} bytes, over the ${maxBytes}-byte limit. Trim it and try again.`,
        isError: true
      };
    }
    const result = await transaction.run({
      summary,
      tier: "persona",
      writes: [{ path: personaRelativePath(file), content: markdown }],
      verifySteps: PERSONA_VERIFY_STEPS
    });
    if (result.status === "applied") {
      return { content: `${file} updated.` };
    }
    if (result.status === "rejected") {
      return { content: `Could not update ${file}: ${result.detail}`, isError: true };
    }
    return { content: `Could not update ${file}: ${result.stepOutput}`, isError: true };
  };

  const defs: ToolDef[] = [
    {
      name: "soul_replace",
      description:
        "Replace the entire SOUL.md file — your core personality, tone, and boundaries. Provide the complete new file content, not a diff.",
      inputSchema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"]
      }
    },
    {
      name: "identity_replace",
      description:
        "Replace the entire IDENTITY.md file — who you are (name, nature, etc). Provide the complete new file content.",
      inputSchema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"]
      }
    },
    {
      name: "user_replace",
      description:
        "Replace the entire USER.md file — what you know about the person you're talking to. Provide the complete new file content.",
      inputSchema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"]
      }
    },
    {
      name: "memory_replace",
      description:
        "Replace the entire MEMORY.md file — your curated long-term memory. Use this whenever you learn something worth remembering. Provide the complete new file content, not a diff; consolidate rather than just appending.",
      inputSchema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"]
      }
    },
    {
      name: "daily_log_append",
      description:
        "Append one short line to today's raw daily log — a quick note-to-self for things that might matter later. Use memory_replace instead for anything that should persist long-term.",
      inputSchema: {
        type: "object",
        properties: { line: { type: "string" } },
        required: ["line"]
      }
    },
    {
      name: "tasks_replace",
      description:
        "Replace the entire TASKS.md file — the user's running list of deadlines and to-dos. Add something the " +
        "instant the user mentions a deadline, and remove things once they're done or clearly no longer relevant. " +
        "Provide the complete new file content, not a diff.",
      inputSchema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"]
      }
    }
  ];

  const handlers: Toolset["handlers"] = {
    soul_replace: async (input) =>
      replaceFile("SOUL.md", requireString(input, "markdown"), SOUL_FILE_MAX_BYTES, "Update SOUL.md"),
    identity_replace: async (input) =>
      replaceFile(
        "IDENTITY.md",
        requireString(input, "markdown"),
        PERSONA_MARKDOWN_MAX_BYTES,
        "Update IDENTITY.md"
      ),
    user_replace: async (input) =>
      replaceFile("USER.md", requireString(input, "markdown"), PERSONA_MARKDOWN_MAX_BYTES, "Update USER.md"),
    memory_replace: async (input) =>
      replaceFile("MEMORY.md", requireString(input, "markdown"), MEMORY_FILE_MAX_BYTES, "Update MEMORY.md"),
    tasks_replace: async (input) =>
      replaceFile("TASKS.md", requireString(input, "markdown"), PERSONA_MARKDOWN_MAX_BYTES, "Update TASKS.md"),

    daily_log_append: async (input) => {
      const line = requireString(input, "line").trim().slice(0, DAILY_LOG_LINE_MAX_CHARS);
      const date = todayISO();
      const abs = personaFilePath(workspaceRoot, `logs/daily/${date}.md`);
      const existing = existsSync(abs) ? await readFile(abs, "utf-8").catch(() => "") : "";
      const timestamp = new Date().toTimeString().slice(0, 5);
      const next = `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}- ${timestamp} ${line}\n`;

      const result = await transaction.run({
        summary: "Append to daily log",
        tier: "persona",
        writes: [{ path: dailyLogRelativePath(date), content: next }],
        verifySteps: PERSONA_VERIFY_STEPS
      });
      if (result.status === "applied") return { content: "Logged." };
      if (result.status === "rejected") return { content: `Could not log: ${result.detail}`, isError: true };
      return { content: `Could not log: ${result.stepOutput}`, isError: true };
    }
  };

  return { defs, handlers };
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
  return value;
}
