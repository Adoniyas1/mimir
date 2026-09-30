import { existsSync } from "node:fs";
import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { PERSONA_TEMPLATES } from "../persona/templates.js";
import { personaFilePath } from "../persona/paths.js";

const COPY_INCLUDE = ["src", "skills", "package.json", "tsconfig.base.json", "tsconfig.main.json", "tsconfig.renderer.json", "tsconfig.supervisor.json", "vite.config.ts", "vitest.config.ts"];

/**
 * The editable workspace is a separate copy of Mimir's own source, living
 * under the app's userData directory and tracked by its own git repo. The
 * running app's install directory is never written to directly — self-edit
 * tools only ever touch this workspace, and a core edit takes effect on
 * the *next* restart, which relaunches from the workspace instead of the
 * original install (see supervisor/index.ts).
 *
 * `appSourceRoot` is the running app's own source tree (used to seed the
 * workspace on first run, and to symlink node_modules for dev — a packaged
 * build ships its own node_modules inside the workspace seed instead).
 */
export async function bootstrapWorkspace(appSourceRoot: string, workspaceRoot: string): Promise<void> {
  if (existsSync(path.join(workspaceRoot, ".git"))) return; // already bootstrapped

  await mkdir(workspaceRoot, { recursive: true });
  for (const entry of COPY_INCLUDE) {
    const src = path.join(appSourceRoot, entry);
    const dest = path.join(workspaceRoot, entry);
    if (!existsSync(src)) continue;
    await cp(src, dest, { recursive: true });
  }

  const nodeModulesSrc = path.join(appSourceRoot, "node_modules");
  const nodeModulesDest = path.join(workspaceRoot, "node_modules");
  if (existsSync(nodeModulesSrc) && !existsSync(nodeModulesDest)) {
    try {
      await symlink(nodeModulesSrc, nodeModulesDest, "dir");
    } catch {
      // Symlinks can fail (e.g. Windows without dev-mode/admin) — self-edit
      // verify steps will then need `npm install` run in the workspace once.
    }
  }

  if (!existsSync(path.join(workspaceRoot, "skills"))) {
    await mkdir(path.join(workspaceRoot, "skills"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "skills", "README.md"),
      "# Skills\n\nHot-reloadable capability modules Mimir writes for itself. Each skill is a " +
        "self-contained .ts file exporting a default handler. See src/main/self-edit/tools.ts for " +
        "how these get proposed and applied.\n",
      "utf-8"
    );
  }

  await seedPersonaTemplates(workspaceRoot);

  const git = simpleGit(workspaceRoot);
  await git.init();
  await git.addConfig("user.name", "Mimir");
  await git.addConfig("user.email", "mimir@localhost");
  await git.add(["-A"]);
  await git.commit("mimir: initial workspace snapshot");
}

/** Writes every persona template file, but only where it doesn't already exist —
 * safe to call on every bootstrap without clobbering a personality the user/model
 * has already grown. Use `force: true` for an explicit reset-to-defaults. */
export async function seedPersonaTemplates(workspaceRoot: string, force = false): Promise<void> {
  for (const template of PERSONA_TEMPLATES) {
    const dest = personaFilePath(workspaceRoot, template.path);
    if (!force && existsSync(dest)) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, template.content, "utf-8");
  }
}

export function defaultWorkspaceRoot(userDataDir: string): string {
  return path.join(userDataDir, "workspace");
}

export function defaultAuditFilePath(userDataDir: string): string {
  return path.join(userDataDir, "audit.json");
}
