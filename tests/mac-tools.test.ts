import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMacToolset } from "../src/main/mac/tools.js";

describe("Mac & CAD tools", () => {
  it("opens only supported engineering applications", async () => {
    const calls: string[][] = [];
    const tools = buildMacToolset({ projectsRoot: "/tmp", open: async (args) => { calls.push(args); } });
    const unsupported = await tools.handlers.open_engineering_app?.({ app: "terminal" });
    expect(unsupported?.isError).toBe(true);
    const freecad = await tools.handlers.open_engineering_app?.({ app: "freecad" });
    expect(freecad?.content).toMatch(/opened|not installed/i);
    expect(calls).toHaveLength(freecad?.isError ? 0 : 1);
  });

  it("reveals only existing files inside Mimir Projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mimir-mac-tools-"));
    await writeFile(path.join(root, "part.FCStd"), "example");
    const calls: string[][] = [];
    const tools = buildMacToolset({ projectsRoot: root, open: async (args) => { calls.push(args); } });
    const ok = await tools.handlers.reveal_project_file?.({ path: "part.FCStd" });
    const escape = await tools.handlers.reveal_project_file?.({ path: "../secret" });
    expect(ok?.isError).toBeFalsy();
    expect(calls).toEqual([["-R", path.join(root, "part.FCStd")]]);
    expect(escape?.isError).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
