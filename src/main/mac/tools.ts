import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ToolDef, Toolset } from "../brain/Provider.js";
import { resolveConfinedPath } from "../self-edit/pathGuard.js";

const ENGINEERING_APPS = {
  freecad: { label: "FreeCAD", appPath: "/Applications/FreeCAD.app" },
  kicad: { label: "KiCad", appPath: "/Applications/KiCad/KiCad.app" }
} as const;

type EngineeringApp = keyof typeof ENGINEERING_APPS;

export interface MacToolsetOptions {
  projectsRoot: string;
  open: (args: string[]) => Promise<void>;
}

/** A deliberately small, permission-light macOS surface. Native CAD APIs
 * and generated macros are preferred to brittle GUI scripting; no arbitrary
 * shell commands, application names, or filesystem paths are accepted. */
export function buildMacToolset(opts: MacToolsetOptions): Toolset {
  const defs: ToolDef[] = [
    { name: "inspect_engineering_environment", description: "Check whether FreeCAD and KiCad are installed on this Mac. These are free engineering applications; this only reads local app availability.", inputSchema: { type: "object", properties: {} } },
    { name: "open_engineering_app", description: "Open a supported engineering application on this Mac: FreeCAD for parametric mechanical CAD or KiCad for electronics. This cannot open arbitrary apps.", inputSchema: { type: "object", properties: { app: { type: "string", enum: ["freecad", "kicad"] } }, required: ["app"] } },
    { name: "reveal_project_file", description: "Reveal a Mimir Projects file in Finder. The path must be relative to Mimir Projects, so this cannot browse arbitrary locations on the Mac.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
  ];

  return {
    defs,
    handlers: {
      inspect_engineering_environment: async () => ({ content: Object.entries(ENGINEERING_APPS).map(([, app]) => `${app.label}: ${existsSync(app.appPath) ? "installed" : "not installed"}`).join("\n") }),
      open_engineering_app: async (input) => {
        const key = input.app;
        if (key !== "freecad" && key !== "kicad") return { content: "Choose freecad or kicad.", isError: true };
        const app = ENGINEERING_APPS[key as EngineeringApp];
        if (!existsSync(app.appPath)) return { content: `${app.label} is not installed on this Mac.`, isError: true };
        try { await opts.open([app.appPath]); return { content: `Opened ${app.label}.` }; } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
      },
      reveal_project_file: async (input) => {
        if (typeof input.path !== "string" || !input.path) return { content: "A project-relative path is required.", isError: true };
        try {
          const target = resolveConfinedPath(opts.projectsRoot, input.path);
          if (!existsSync(target)) return { content: `Project file not found: ${input.path}`, isError: true };
          await opts.open(["-R", target]);
          return { content: `Revealed ${input.path} in Finder.` };
        } catch (error) { return { content: error instanceof Error ? error.message : String(error), isError: true }; }
      }
    }
  };
}

export function openWithMac(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("open", args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`macOS open exited with ${code ?? "an unknown error"}.`)));
  });
}
