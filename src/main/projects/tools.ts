import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ToolDef, Toolset } from "../brain/Provider.js";
import { resolveConfinedPath } from "../self-edit/pathGuard.js";
import { commitFolderChange, listFolderHistory, revertFolderFile } from "../lib/versionedFolder.js";
import { renderTextToPdf } from "./pdf.js";
import type { ProjectFileCorpusEntry, SemanticSearchHit } from "../../shared/types.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", ".DS_Store"]);
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_HITS = 200;
const SEMANTIC_SEARCH_EXT = /\.(md|txt|py|ts|tsx|js|jsx|json|csv|c|cpp|h|hpp|java|m|matlab|rs|go|sh|yaml|yml|toml|ini|log|tex)$/i;
const MAX_SEMANTIC_CORPUS_FILES = 150;
const MAX_SEMANTIC_FILE_BYTES = 200_000;
const SEMANTIC_TOP_K = 8;

export interface ProjectsToolsetOptions {
  projectsRoot: string;
  /** Bridges to the renderer's local embedding model — see
   * src/renderer/search/projectSearch.ts for the actual ranking. */
  semanticSearch: (query: string, corpus: ProjectFileCorpusEntry[], topK: number) => Promise<SemanticSearchHit[]>;
}


/**
 * Read/write access to the user's actual project files (schoolwork,
 * engineering notes, saved datasheets — see paths.ts). Unlike self-edit's
 * tools, these writes aren't gated behind git checkpoints or approval:
 * it's the user's own files, not the app's source, so the risk profile is
 * completely different. Every write_project_file call is still versioned
 * (see ../lib/versionedFolder.ts) so an overwrite isn't permanently destructive, just
 * without the approval gate or verify pipeline self-edit has.
 */
export function buildProjectsToolset(opts: ProjectsToolsetOptions): Toolset {
  const { projectsRoot } = opts;

  const defs: ToolDef[] = [
    {
      name: "list_project_files",
      description:
        "List files under a directory in the user's Projects folder (schoolwork, engineering files). " +
        "Relative path; omit for the root.",
      inputSchema: {
        type: "object",
        properties: { dir: { type: "string" } }
      }
    },
    {
      name: "read_project_file",
      description: "Read a text file from the user's Projects folder, by path relative to its root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    {
      name: "write_project_file",
      description:
        "Create or overwrite a file in the user's Projects folder — save notes, calculations, drafts, " +
        "generated code, anything project-related. Creates parent directories as needed. This is for the " +
        "user's own project files, never for Mimir's own source (use propose_edit for that).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "search_project_files",
      description: "Search text files in the user's Projects folder for a literal or regex substring.",
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
      name: "list_project_file_history",
      description:
        "List recent saved versions of a file in the Projects folder (or the whole folder's recent activity " +
        "if no path is given), most recent first. Every write_project_file call is versioned automatically.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } }
      }
    },
    {
      name: "revert_project_file",
      description:
        "Restore a file in the Projects folder to an earlier saved version, by the commit id from " +
        "list_project_file_history. Creates a new version rather than erasing history, so this is itself " +
        "undoable.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          commit: { type: "string" }
        },
        required: ["path", "commit"]
      }
    },
    {
      name: "export_to_pdf",
      description:
        "Render text (light markdown: # headings, ``` code fences, blank-line paragraphs) to a real PDF and " +
        "save it in the Projects folder — for turning a worked solution or written answer into something " +
        "submittable. Not for exporting existing binary files; this generates a new PDF from text content.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Where to save it, relative to the Projects folder, e.g. \"lab3/report.pdf\"." },
          title: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "title", "content"]
      }
    },
    {
      name: "semantic_search_project_files",
      description:
        "Search the Projects folder by meaning rather than exact text — good for a question like \"what did " +
        "the syllabus say about the midterm\" where you don't know the exact wording. Slower than " +
        "search_project_files (loads a small local embedding model on first use in a session); prefer " +
        "search_project_files when you already know the literal phrase to look for.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  ];

  const handlers: Toolset["handlers"] = {
    list_project_files: async (input) => {
      const dir = typeof input.dir === "string" ? input.dir : ".";
      try {
        await ensureProjectsRoot(projectsRoot);
        const abs = resolveConfinedPath(projectsRoot, dir);
        const files = await listRecursive(abs, projectsRoot);
        return { content: files.slice(0, MAX_LIST_RESULTS).join("\n") || "(empty)" };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    read_project_file: async (input) => {
      const rel = requireString(input, "path");
      try {
        const abs = resolveConfinedPath(projectsRoot, rel);
        return { content: await readFile(abs, "utf-8") };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    write_project_file: async (input) => {
      const rel = requireString(input, "path");
      const content = requireString(input, "content");
      try {
        const abs = resolveConfinedPath(projectsRoot, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf-8");
        // Best-effort: a versioning hiccup shouldn't turn a successful save
        // into a reported failure — the file itself is already on disk.
        await commitFolderChange(projectsRoot, `mimir: saved ${rel}`).catch(() => undefined);
        return { content: `Saved ${rel} to your Projects folder.` };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    search_project_files: async (input) => {
      const query = requireString(input, "query");
      const useRegex = input.regex === true;
      try {
        await ensureProjectsRoot(projectsRoot);
        const matcher = useRegex ? new RegExp(query) : null;
        const files = await listRecursive(projectsRoot, projectsRoot);
        const hits: string[] = [];
        for (const rel of files) {
          if (hits.length > MAX_SEARCH_HITS) break;
          const abs = path.join(projectsRoot, rel);
          const text = await readFile(abs, "utf-8").catch(() => null);
          if (text === null) continue; // binary or unreadable — skip rather than error the whole search
          text.split("\n").forEach((line, i) => {
            const found = matcher ? matcher.test(line) : line.includes(query);
            if (found) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
        }
        return { content: hits.slice(0, MAX_SEARCH_HITS).join("\n") || "No matches." };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    list_project_file_history: async (input) => {
      const rel = typeof input.path === "string" && input.path.length > 0 ? input.path : undefined;
      try {
        if (rel) resolveConfinedPath(projectsRoot, rel); // validate before touching git
        const entries = await listFolderHistory(projectsRoot, rel);
        if (entries.length === 0) return { content: "No saved versions yet." };
        return { content: entries.map((e) => `${e.hash}  ${e.date}  ${e.message}`).join("\n") };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    revert_project_file: async (input) => {
      const rel = requireString(input, "path");
      const commit = requireString(input, "commit");
      try {
        resolveConfinedPath(projectsRoot, rel); // validate before touching git
        await revertFolderFile(projectsRoot, rel, commit);
        return { content: `Reverted ${rel} to version ${commit}.` };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    export_to_pdf: async (input) => {
      let rel = requireString(input, "path");
      const title = requireString(input, "title");
      const content = requireString(input, "content");
      if (!rel.toLowerCase().endsWith(".pdf")) rel += ".pdf";
      try {
        const abs = resolveConfinedPath(projectsRoot, rel);
        const pdf = await renderTextToPdf(title, content);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, pdf);
        await commitFolderChange(projectsRoot, `mimir: exported ${rel}`).catch(() => undefined);
        return { content: `Saved ${rel} to your Projects folder.` };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    },

    semantic_search_project_files: async (input) => {
      const query = requireString(input, "query");
      try {
        const corpus = await gatherSemanticCorpus(projectsRoot);
        if (corpus.length === 0) return { content: "No searchable project files yet." };
        const hits = await opts.semanticSearch(query, corpus, SEMANTIC_TOP_K);
        if (hits.length === 0) return { content: "No relevant matches found." };
        return { content: hits.map((h) => `${h.path} (relevance ${h.score.toFixed(2)}):\n${h.snippet}`).join("\n\n---\n\n") };
      } catch (err) {
        return { content: errMsg(err), isError: true };
      }
    }
  };

  return { defs, handlers };
}

/** Gathers text content for embedding — skips anything binary-ish or too
 * large to be worth the embedding cost, and caps total file count so a
 * huge Projects folder doesn't stall the first search of a session. */
async function gatherSemanticCorpus(projectsRoot: string): Promise<ProjectFileCorpusEntry[]> {
  await ensureProjectsRoot(projectsRoot);
  const files = await listRecursive(projectsRoot, projectsRoot);
  const entries: ProjectFileCorpusEntry[] = [];
  for (const rel of files) {
    if (entries.length >= MAX_SEMANTIC_CORPUS_FILES) break;
    if (!SEMANTIC_SEARCH_EXT.test(rel)) continue;
    const abs = path.join(projectsRoot, rel);
    try {
      const info = await stat(abs);
      if (info.size > MAX_SEMANTIC_FILE_BYTES) continue;
      const content = await readFile(abs, "utf-8");
      entries.push({ path: rel, content, mtimeMs: info.mtimeMs });
    } catch {
      continue; // unreadable/binary — skip rather than fail the whole search
    }
  }
  return entries;
}

async function ensureProjectsRoot(projectsRoot: string): Promise<void> {
  if (!existsSync(projectsRoot)) await mkdir(projectsRoot, { recursive: true });
}

async function listRecursive(dir: string, root: string, depth = 0): Promise<string[]> {
  if (depth > 10 || !existsSync(dir)) return [];
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
