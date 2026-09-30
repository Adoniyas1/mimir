import type { ToolResult } from "../brain/Provider.js";
import { buildProjectsToolset } from "../projects/tools.js";
import { defaultProjectsRoot } from "../projects/paths.js";

/**
 * The fixed, complete set of names a skill's `capabilities` manifest entry
 * may ever contain — checked twice: once here against the whole app (a
 * name outside this set is never dispatchable, no matter what a skill
 * declares), and again per-call against the specific skill's own declared
 * list (see the `declared` param below) so one skill can never reach a
 * capability only a different skill asked for.
 *
 * Deliberately just the read-only-ish Projects trio for this first pass —
 * the user's own files, not Mimir's source (self-edit), not the Mac
 * (mac/tools.ts), not another skill (run_skill/verify_skill would let a
 * skill call itself into a worker that's already busy awaiting it — a
 * guaranteed deadlock, not just a bad idea), and not run_python itself
 * (same deadlock shape). Extending this set later means writing a new
 * confined handler under a real toolset, the same review bar as any other
 * tool — never a raw filesystem or shell escape hatch.
 */
export const HOST_CAPABILITY_NAMES = ["list_project_files", "read_project_file", "write_project_file"] as const;
export type HostCapabilityName = (typeof HOST_CAPABILITY_NAMES)[number];

const CAPABILITY_SET = new Set<string>(HOST_CAPABILITY_NAMES);

export function isHostCapabilityName(name: string): name is HostCapabilityName {
  return CAPABILITY_SET.has(name);
}

/**
 * Builds the dispatch function a skill's host calls are routed through.
 * Reuses buildProjectsToolset's own handlers verbatim — confinement to
 * Mimir Projects (resolveConfinedPath) and file versioning are already
 * correct there; this is deliberately not a second implementation of any
 * of that. semanticSearch is stubbed since none of the three exposed
 * capabilities call it. `projectsRoot` defaults to the real Mimir Projects
 * folder; overridable so tests can point it at a throwaway directory
 * instead of the real user's Documents folder.
 */
export function buildHostCapabilityDispatch(
  projectsRoot: string = defaultProjectsRoot()
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  const projects = buildProjectsToolset({ projectsRoot, semanticSearch: async () => [] });

  return async (name, input) => {
    if (!isHostCapabilityName(name)) {
      return { content: `"${name}" is not a capability a skill can declare.`, isError: true };
    }
    const handler = projects.handlers[name];
    if (!handler) {
      return { content: `"${name}" has no handler wired up — this is an app bug, not a skill error.`, isError: true };
    }
    return handler(input);
  };
}

/**
 * Per-call authorization: even though CAPABILITY_SET is the fixed ceiling
 * for the whole app, a specific run only gets what that specific skill
 * actually declared in its manifest — one skill's declared capabilities
 * are never available to a different skill's run just because both are
 * valid app-wide names.
 */
export function isCapabilityDeclaredForRun(name: string, declared: readonly string[]): boolean {
  return isHostCapabilityName(name) && declared.includes(name);
}
