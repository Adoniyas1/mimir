import { describe, expect, it } from "vitest";
import { sanitizeSpeech, takeCompleteSentences } from "../src/renderer/voice/speech.js";

describe("speech output", () => {
  it("speaks complete streamed sentences and retains an unfinished tail", () => {
    expect(takeCompleteSentences("Hello there. How are you? Still writing")).toEqual({
      chunks: ["Hello there. ", "How are you? "],
      remainder: "Still writing"
    });
  });

  it("does not send runtime context or memory-tool leakage to TTS", () => {
    const leaked = "[Sun Aug 09 2026 21:42:35 GMT-0700 (Pacific Daylight Time)]\nuser_replace MEMORY.md\n\"Contextual information retrieval and summarization\"\nHello, I can help.";
    expect(sanitizeSpeech(leaked)).toBe("Hello, I can help.");
  });
});
