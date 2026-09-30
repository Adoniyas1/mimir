import { SelfEditTransaction, type TransactionResult } from "../self-edit/transaction.js";
import { PERSONA_VERIFY_STEPS } from "../self-edit/verifyPresets.js";
import { PERSONA_TEMPLATES } from "./templates.js";
import { personaRelativePath } from "./paths.js";

/**
 * Overwrites every persona file back to its template content, as a single
 * persona-tier transaction — so "Reset personality to defaults" gets an
 * audit-log entry and a revert button, same as everything else, instead of
 * silently clobbering whatever personality Mimir had grown.
 */
export async function resetPersonaToDefaults(
  workspaceRoot: string,
  auditFilePath: string
): Promise<TransactionResult> {
  const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
  return transaction.run({
    summary: "Reset personality to defaults",
    tier: "persona",
    writes: PERSONA_TEMPLATES.map((t) => ({ path: personaRelativePath(t.path), content: t.content })),
    verifySteps: PERSONA_VERIFY_STEPS
  });
}
