import { createBrainProvider } from "../brain/index.js";
import { shouldEnableSelfEdit } from "../agent/session.js";
import { buildSelfEditToolset } from "../self-edit/tools.js";
import { SelfEditTransaction } from "../self-edit/transaction.js";
import { buildPersonaToolset } from "../persona/tools.js";
import { buildProjectsToolset } from "../projects/tools.js";
import { buildComputeToolset } from "../compute/tools.js";
import { buildSkillsToolset } from "./tools.js";
import { defaultProjectsRoot } from "../projects/paths.js";
import { defaultSkillsRoot } from "./paths.js";
import { buildMacToolset, openWithMac } from "../mac/tools.js";
import { buildEngineeringToolset, runCalculiX, runFreeCadMacro, runKicadDrc, runKicadErc, runNgspice } from "../engineering/tools.js";
import { buildEngineeringWorkflowToolset } from "../engineering/workflow.js";

export interface BuiltInCapability {
  name: string;
  description: string;
  category: string;
}

/**
 * Every tool the current model has natively — not something it taught
 * itself via create_skill, just always there. Shown in the Skill Tree
 * alongside self-taught skills so "what can this AI actually do" is the
 * whole picture, not just the part it built for itself. Reuses the exact
 * same build*Toolset() functions session.ts wires into a real
 * conversation, so this list can never drift from what's actually offered
 * — the dependencies passed in are stubs (never invoked, this only reads
 * .defs) since listing tools doesn't need to run any of them.
 */
export async function listBuiltInCapabilities(workspaceRoot: string, auditFilePath: string): Promise<BuiltInCapability[]> {
  const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
  const noRunPython = async () => ({ stdout: "", result: null, error: "Not available outside a real conversation." });

  const persona = buildPersonaToolset({ workspaceRoot, transaction });
  const projects = buildProjectsToolset({ projectsRoot: defaultProjectsRoot(), semanticSearch: async () => [] });
  const compute = buildComputeToolset({ runPython: noRunPython, resetPython: () => undefined });
  const skillsMeta = buildSkillsToolset({ skillsRoot: defaultSkillsRoot(), runPython: noRunPython });
  const mac = buildMacToolset({ projectsRoot: defaultProjectsRoot(), open: openWithMac });
  const engineering = buildEngineeringToolset({ projectsRoot: defaultProjectsRoot(), runFreeCad: runFreeCadMacro, runCalculiX, runNgspice, runKicadErc, runKicadDrc });
  const workflow = buildEngineeringWorkflowToolset(defaultProjectsRoot());

  const capabilities: BuiltInCapability[] = [
    ...persona.defs.map((d) => ({ name: d.name, description: d.description, category: "Memory & Identity" })),
    ...projects.defs.map((d) => ({ name: d.name, description: d.description, category: "Projects" })),
    ...compute.defs.map((d) => ({ name: d.name, description: d.description, category: "Compute" })),
    ...skillsMeta.defs.map((d) => ({ name: d.name, description: d.description, category: "Skill-Building" })),
    ...mac.defs.map((d) => ({ name: d.name, description: d.description, category: "Mac & CAD" })),
    ...engineering.defs.map((d) => ({ name: d.name, description: d.description, category: "Engineering Automation" })),
    ...workflow.defs.map((d) => ({ name: d.name, description: d.description, category: "Engineering Automation" }))
  ];

  // Self-edit depends on which model is actually configured right now (see
  // shouldEnableSelfEdit) — no provider configured yet, or a provider that
  // can't be reached, just means this section is empty, not an error.
  try {
    const provider = await createBrainProvider();
    if (shouldEnableSelfEdit(provider)) {
      const selfEdit = buildSelfEditToolset({
        workspaceRoot,
        transaction,
        gate: { requestApproval: async () => "rejected" },
        getAutoApproveCoreEdits: async () => false
      });
      capabilities.push(...selfEdit.defs.map((d) => ({ name: d.name, description: d.description, category: "Self-Edit" })));
    }
  } catch {
    // No usable provider — self-edit section just doesn't appear.
  }

  return capabilities;
}
