import { describe, expect, it } from "vitest";
import { resolveToolTier, shouldEnableSelfEdit } from "../src/main/agent/session.js";

describe("resolveToolTier", () => {
  it("gives an Ollama model at 7B or under the core tier", () => {
    expect(resolveToolTier({ kind: "ollama", model: "llama3.2:3b" })).toBe("core");
    expect(resolveToolTier({ kind: "ollama", model: "llama3.1:7b" })).toBe("core");
    expect(resolveToolTier({ kind: "ollama", model: "phi3:3.8b" })).toBe("core");
  });

  it("gives an Ollama model over 7B the full tier", () => {
    expect(resolveToolTier({ kind: "ollama", model: "llama3.1:8b" })).toBe("full");
    expect(resolveToolTier({ kind: "ollama", model: "qwen2.5:14b" })).toBe("full");
    expect(resolveToolTier({ kind: "ollama", model: "llama3.3:70b" })).toBe("full");
  });

  it("gives an Ollama tag with no parseable size the core tier, not full", () => {
    // Regression test for a real bug: the old regex matched nothing for a
    // tag like "llama3.2" (no explicit :Nb) and fell through to the FULL
    // toolset, while "llama3.2:3b" — the identical weights — got zero
    // tools. Absence of a size is not evidence of a large model.
    expect(resolveToolTier({ kind: "ollama", model: "llama3.2" })).toBe("core");
    expect(resolveToolTier({ kind: "ollama", model: "mistral" })).toBe("core");
    expect(resolveToolTier({ kind: "ollama", model: "my-custom-model:latest" })).toBe("core");
  });

  it("always gives a non-Ollama provider the full tier, regardless of model name", () => {
    expect(resolveToolTier({ kind: "anthropic", model: "claude-opus-5" })).toBe("full");
    expect(resolveToolTier({ kind: "openai-compatible", model: "some-3b-model" })).toBe("full");
  });
});

describe("shouldEnableSelfEdit", () => {
  it("matches resolveToolTier's full/core split exactly", () => {
    expect(shouldEnableSelfEdit({ kind: "ollama", model: "llama3.2:3b" })).toBe(false);
    expect(shouldEnableSelfEdit({ kind: "ollama", model: "llama3.1:8b" })).toBe(true);
    expect(shouldEnableSelfEdit({ kind: "anthropic", model: "claude-opus-5" })).toBe(true);
  });
});
