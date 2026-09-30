import { describe, expect, it } from "vitest";
import { LLAMA31_CAPABILITIES, LLAMA31_PROFILE_CATEGORY } from "../src/shared/llama31Capabilities.js";

describe("Llama 3.1 8B Skill Tree profile", () => {
  it("shows every documented capability area as a clearly graded reference node", () => {
    expect(LLAMA31_PROFILE_CATEGORY).toBe("Llama 3.1 8B Profile");
    expect(LLAMA31_CAPABILITIES).toHaveLength(21);
    for (const capability of LLAMA31_CAPABILITIES) {
      expect(capability.name).not.toHaveLength(0);
      expect(capability.description).not.toHaveLength(0);
      expect(capability.grade).toMatch(/^[ABC][+-]?$/);
    }
  });
});
