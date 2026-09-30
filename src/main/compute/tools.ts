import type { ToolDef, Toolset } from "../brain/Provider.js";
import type { PythonRunResult } from "../../shared/types.js";

const MAX_TOOL_OUTPUT_CHARS = 20_000;

/** The bridge every skill/compute execution path calls through to reach
 * the renderer's sandboxed Pyodide worker (see pyodideWorker.ts). `args` is
 * bound as the `args` global; `capabilities` is the fixed, per-run list of
 * host capabilities (see compute/hostCapabilities.ts) the code may call
 * back into — only ever non-empty for a parameterized skill that declared
 * some in its manifest (skills/dynamicTools.ts). run_python itself always
 * omits both, running a plain script with neither. */
export type RunPythonFn = (code: string, args?: Record<string, unknown>, capabilities?: string[]) => Promise<PythonRunResult>;

export interface ComputeToolsetOptions {
  /** Bridges to the renderer's sandboxed Pyodide worker — see
   * src/renderer/python/pyodideWorker.ts for what's actually enforced.
   * `args`/`capabilities`, when given, come from a parameterized
   * skill_<name> call (see dynamicTools.ts) — run_python itself always
   * omits both. */
  runPython: RunPythonFn;
  resetPython: () => void;
}

/**
 * Real computation, not language-model mental math — for anything
 * numeric where an approximate answer isn't good enough: circuit/physics
 * calculations, unit conversions, symbolic math, data analysis. Runs in a
 * sandboxed WASM Python interpreter in the renderer (see pyodideWorker.ts
 * for exactly what it can and can't touch); this module is just the tool
 * surface + a bridge to it, it has no execution logic of its own.
 */
export function buildComputeToolset(opts: ComputeToolsetOptions): Toolset {
  const defs: ToolDef[] = [
    {
      name: "run_python",
      description:
        "Run Python code for real computation — arithmetic you don't trust yourself to get exactly right, " +
        "unit conversions, circuit/physics formulas, symbolic math (sympy), array/data work (numpy), plotting " +
        "data. numpy/sympy/pandas/matplotlib and the rest of Pyodide's supported package set are available and " +
        "load automatically when imported (may take a moment on first use). To plot, use matplotlib normally " +
        "(e.g. plt.plot(...) / plt.show() or just leave the figure open) — any open figure is automatically " +
        "captured and shown to the user right in the chat; don't try to save it to a file or describe it in " +
        "words instead. Variables persist across calls in this conversation — define something once, reuse it " +
        "later. Runs in an isolated sandbox: no real filesystem access, no arbitrary network access, and a ~20s " +
        "time limit. Print anything you want visible in the output; the value of the last expression is also " +
        "captured automatically, like a REPL.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"]
      }
    },
    {
      name: "reset_python",
      description: "Clear all variables in the Python sandbox and start fresh. Use if state gets confusing.",
      inputSchema: { type: "object", properties: {} }
    }
  ];

  const handlers: Toolset["handlers"] = {
    run_python: async (input) => {
      const code = requireString(input, "code");
      let outcome: PythonRunResult;
      try {
        outcome = await opts.runPython(code);
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }

      if (outcome.error) {
        const parts = [`Error:\n${outcome.error}`];
        if (outcome.stdout.trim()) parts.push(`Output before the error:\n${outcome.stdout.trim()}`);
        return { content: cap(parts.join("\n\n")), isError: true };
      }

      const parts: string[] = [];
      if (outcome.stdout.trim()) parts.push(`Output:\n${outcome.stdout.trim()}`);
      if (outcome.result !== null) parts.push(`Result: ${outcome.result}`);
      if (outcome.images?.length) parts.push(`(${outcome.images.length} plot(s) generated and shown to the user.)`);
      return {
        content: cap(parts.join("\n\n")) || "(ran with no output)",
        images: outcome.images
      };
    },

    reset_python: async () => {
      opts.resetPython();
      return { content: "Python sandbox reset — all variables cleared." };
    }
  };

  return { defs, handlers };
}

function cap(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[...truncated...]` : text;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}
