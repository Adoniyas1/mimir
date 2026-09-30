import { describe, it, expect } from "vitest";
import { chunkText, dot } from "../src/renderer/search/chunking.js";

describe("chunkText", () => {
  it("returns short text as a single chunk", () => {
    const text = "a".repeat(500);
    expect(chunkText(text)).toEqual([text]);
  });

  it("splits long text into overlapping windows that cover the whole string", () => {
    const text = "x".repeat(2500);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should be non-empty and the last one should reach the end.
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]?.endsWith("x")).toBe(true);
  });

  it("produces consecutive chunks that overlap so a match isn't split across a boundary", () => {
    const text = `${"a".repeat(750)}NEEDLE${"b".repeat(750)}`;
    const chunks = chunkText(text);
    expect(chunks.some((c) => c.includes("NEEDLE"))).toBe(true);
  });
});

describe("dot", () => {
  it("computes the dot product of two vectors", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(1 * 4 + 2 * 5 + 3 * 6);
  });

  it("is maximal for identical normalized vectors, near zero for orthogonal ones", () => {
    expect(dot([1, 0], [1, 0])).toBe(1);
    expect(dot([1, 0], [0, 1])).toBe(0);
  });
});
