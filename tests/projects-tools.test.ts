import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectsToolset } from "../src/main/projects/tools.js";
import type { ProjectFileCorpusEntry, SemanticSearchHit } from "../src/shared/types.js";

let projectsRoot: string;
const noopSemanticSearch = async (): Promise<SemanticSearchHit[]> => [];

beforeEach(async () => {
  projectsRoot = await mkdtemp(path.join(os.tmpdir(), "mimir-projects-test-"));
});

afterEach(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
});

describe("projects toolset", () => {
  it("writes a file and reads it back", async () => {
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch: noopSemanticSearch });

    const writeResult = await handlers.write_project_file?.({
      path: "lab3/notes.md",
      content: "# Lab 3\n\nResistance measured at 220 ohms.\n"
    });
    expect(writeResult?.isError).toBeFalsy();

    const readResult = await handlers.read_project_file?.({ path: "lab3/notes.md" });
    expect(readResult?.content).toContain("220 ohms");
  });

  it("lists and searches files under the projects root", async () => {
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch: noopSemanticSearch });
    await handlers.write_project_file?.({ path: "a.md", content: "alpha\n" });
    await handlers.write_project_file?.({ path: "sub/b.md", content: "beta and alpha\n" });

    const listResult = await handlers.list_project_files?.({});
    expect(listResult?.content).toContain("a.md");
    expect(listResult?.content).toContain(path.join("sub", "b.md"));

    const searchResult = await handlers.search_project_files?.({ query: "alpha" });
    expect(searchResult?.content).toContain("a.md");
    expect(searchResult?.content).toContain(path.join("sub", "b.md"));
  });

  it("refuses to read or write outside the projects root", async () => {
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch: noopSemanticSearch });

    // Handlers catch resolveConfinedPath's PathEscapeError and surface it as
    // a normal (isError: true) tool result — same convention as
    // self-edit/tools.ts's read_file/list_files/search — rather than
    // rejecting, so a confused model gets a message it can react to.
    const writeResult = await handlers.write_project_file?.({ path: "../outside.txt", content: "x" });
    expect(writeResult?.isError).toBe(true);
    expect(writeResult?.content).toMatch(/escapes/i);

    const readResult = await handlers.read_project_file?.({ path: "../../etc/passwd" });
    expect(readResult?.isError).toBe(true);
    expect(readResult?.content).toMatch(/escapes/i);
  });

  it("creates the projects root on first use if it doesn't exist yet", async () => {
    await rm(projectsRoot, { recursive: true, force: true });
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch: noopSemanticSearch });

    const result = await handlers.list_project_files?.({});
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toBe("(empty)");
  });

  it("versions every write and can revert to an earlier one", async () => {
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch: noopSemanticSearch });

    await handlers.write_project_file?.({ path: "notes.md", content: "draft one\n" });
    await handlers.write_project_file?.({ path: "notes.md", content: "draft two\n" });

    const history = await handlers.list_project_file_history?.({ path: "notes.md" });
    expect(history?.isError).toBeFalsy();
    const commits = (history?.content ?? "").split("\n").filter(Boolean);
    expect(commits.length).toBeGreaterThanOrEqual(2);

    const oldestCommit = commits[commits.length - 1]?.split(/\s+/)[0];
    expect(oldestCommit).toBeTruthy();

    const revertResult = await handlers.revert_project_file?.({ path: "notes.md", commit: oldestCommit as string });
    expect(revertResult?.isError).toBeFalsy();

    const readResult = await handlers.read_project_file?.({ path: "notes.md" });
    expect(readResult?.content).toBe("draft one\n");
  });

  it("gathers the text corpus and hands it to the semantic search bridge", async () => {
    const semanticSearch = vi.fn(async (query: string, corpus: ProjectFileCorpusEntry[]): Promise<SemanticSearchHit[]> => {
      const hit = corpus.find((f) => f.content.includes(query));
      return hit ? [{ path: hit.path, snippet: hit.content.slice(0, 40), score: 0.9 }] : [];
    });
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch });
    await handlers.write_project_file?.({ path: "syllabus.md", content: "The midterm covers chapters 1-4.\n" });
    await handlers.write_project_file?.({ path: "photo.png", content: "not real image bytes but irrelevant here" });

    const result = await handlers.semantic_search_project_files?.({ query: "midterm" });
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toContain("syllabus.md");
    expect(semanticSearch).toHaveBeenCalledTimes(1);

    // .png isn't in the searchable-extension allowlist, so the corpus this
    // handler builds should never have included it.
    const corpusArg = semanticSearch.mock.calls[0]?.[1] as ProjectFileCorpusEntry[];
    expect(corpusArg.some((f) => f.path === "photo.png")).toBe(false);
  });

  it("reports no searchable files rather than erroring on an empty projects folder", async () => {
    const { handlers } = buildProjectsToolset({ projectsRoot, semanticSearch: noopSemanticSearch });
    const result = await handlers.semantic_search_project_files?.({ query: "anything" });
    expect(result?.isError).toBeFalsy();
    expect(result?.content).toMatch(/no searchable/i);
  });
});
