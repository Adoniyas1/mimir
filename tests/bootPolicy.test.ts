import { describe, it, expect } from "vitest";
import { decideBootAction, MAX_CONSECUTIVE_FAILURES } from "../supervisor/bootPolicy.js";

describe("decideBootAction", () => {
  it("boots the active (workspace) build while under the failure budget", () => {
    for (let n = 0; n < MAX_CONSECUTIVE_FAILURES; n++) {
      expect(decideBootAction({ consecutiveFailures: n }).action).toBe("boot-active");
    }
  });

  it("reverts to the fallback once the failure budget is exhausted", () => {
    expect(decideBootAction({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }).action).toBe(
      "revert-and-boot-fallback"
    );
    expect(decideBootAction({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES + 5 }).action).toBe(
      "revert-and-boot-fallback"
    );
  });
});
