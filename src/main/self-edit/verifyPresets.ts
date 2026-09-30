import type { VerifyStep } from "./transaction.js";

/**
 * Default gate pipelines. "Skill" edits are cheap and hot-reloadable, so
 * they get a fast typecheck-only gate. "Core" edits touch the app that's
 * currently running, so they get the full pipeline before a restart is
 * even considered.
 *
 * These assume the workspace root has its own package.json/tsconfig and a
 * `node_modules` available (see src/main/self-edit/workspace.ts, which
 * symlinks it from the host install in dev). Tests inject their own much
 * cheaper fake steps — see tests/transaction.test.ts — so this file is
 * never imported by the unit tests.
 */
export const SKILL_VERIFY_STEPS: VerifyStep[] = [
  { name: "typecheck", command: "npx tsc -p tsconfig.main.json --noEmit", timeoutMs: 45_000 }
];

/**
 * Persona/memory edits are markdown, not code — nothing to typecheck or
 * test, so there's nothing to gate. Still goes through the same
 * checkpoint/commit/audit-log machinery as every other tier, just with an
 * empty pipeline (equivalent to "always passes immediately").
 */
export const PERSONA_VERIFY_STEPS: VerifyStep[] = [];

export const CORE_VERIFY_STEPS: VerifyStep[] = [
  { name: "typecheck", command: "npx tsc -p tsconfig.main.json --noEmit", timeoutMs: 45_000 },
  { name: "typecheck-renderer", command: "npx tsc -p tsconfig.renderer.json --noEmit", timeoutMs: 45_000 },
  { name: "test", command: "npx vitest run", timeoutMs: 120_000 }
];
