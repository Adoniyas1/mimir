import { describe, it, expect } from "vitest";
import { MERMAID_FENCE } from "../src/renderer/MessageContent.js";

function firstMatchCode(text: string): string | null {
  MERMAID_FENCE.lastIndex = 0;
  const match = MERMAID_FENCE.exec(text);
  return match?.[1] ?? null;
}

describe("MERMAID_FENCE", () => {
  it("matches the well-formed case (newline right after the language tag)", () => {
    const text = "```mermaid\ngraph LR\nA-->B\n```";
    expect(firstMatchCode(text)).toBe("graph LR\nA-->B\n");
  });

  it("regression: still matches when a small model glues the language tag straight onto content, no newline", () => {
    // Live-observed pattern: "```mermaidgraph LR..." — previously fell
    // through unmatched and leaked as raw fence text into the chat.
    const text = "```mermaidgraph LR\nA-->B\n```";
    expect(firstMatchCode(text)).toBe("graph LR\nA-->B\n");
  });

  it("tolerates trailing spaces/tabs between the language tag and the newline", () => {
    const text = "```mermaid   \ngraph LR\nA-->B\n```";
    expect(firstMatchCode(text)).toBe("graph LR\nA-->B\n");
  });
});
