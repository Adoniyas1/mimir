import path from "node:path";

/**
 * Resolves a model-supplied relative path against a fixed workspace root
 * and throws if it would escape that root — via `..`, an absolute path,
 * or (best-effort) a symlink. Every write in the self-edit tool surface
 * must go through this. Never pass a raw model-supplied path to fs directly.
 */
export function resolveConfinedPath(workspaceRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathEscapeError(`Absolute paths are not allowed: ${relativePath}`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathEscapeError(`Path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

export class PathEscapeError extends Error {}
