/**
 * Pure crash-loop decision logic, deliberately separated from any I/O so it
 * can be unit tested directly (tests/bootPolicy.test.ts) and reasoned about
 * without spawning a real Electron process.
 *
 * This file — along with electron-entry.mjs at the repo root and the rest
 * of supervisor/ — is the immutable safety floor described in the plan:
 * nothing in src/main/self-edit exposes a tool that can write here, so no
 * self-edit, however broken, can disable the mechanism that would revert it.
 */

export const MAX_CONSECUTIVE_FAILURES = 3;

export interface BootAttemptState {
  consecutiveFailures: number;
}

export type BootDecision =
  | { action: "boot-active"; reason: string }
  | { action: "revert-and-boot-fallback"; reason: string };

export function decideBootAction(state: BootAttemptState): BootDecision {
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      action: "revert-and-boot-fallback",
      reason:
        `${state.consecutiveFailures} consecutive failed boots (limit ${MAX_CONSECUTIVE_FAILURES}) — ` +
        "reverting to the last known-good install instead of the self-edited workspace."
    };
  }
  return {
    action: "boot-active",
    reason: `${state.consecutiveFailures} consecutive failures, within the ${MAX_CONSECUTIVE_FAILURES}-attempt budget.`
  };
}
