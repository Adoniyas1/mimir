import type { BrowserWindow } from "electron";
import { createBrainProvider, loadBrainConfig } from "../brain/index.js";
import type { Attachment, BrainMessage } from "../brain/Provider.js";
import { runAgentTurn } from "./loop.js";
import { SelfEditTransaction } from "../self-edit/transaction.js";
import { buildSelfEditToolset, type EditApprovalGate } from "../self-edit/tools.js";
import { applyCoreEditAndMaybeRestart } from "../self-edit/restart.js";
import { AuditLog } from "../self-edit/audit.js";
import { buildComposedSystemPrompt, buildTurnContext } from "../persona/compose.js";
import { buildPersonaToolset } from "../persona/tools.js";
import { LOCAL_DAILY_LOG_INJECT_DAYS, LOCAL_MEMORY_INJECT_MAX_CHARS } from "../persona/templates.js";
import { buildProjectsToolset } from "../projects/tools.js";
import { defaultProjectsRoot } from "../projects/paths.js";
import { buildComputeToolset } from "../compute/tools.js";
import { buildSkillsToolset } from "../skills/tools.js";
import { buildDynamicSkillTools } from "../skills/dynamicTools.js";
import { defaultSkillsRoot } from "../skills/paths.js";
import { buildMacToolset, openWithMac } from "../mac/tools.js";
import { buildEngineeringToolset, runCalculiX, runFreeCadMacro, runKicadDrc, runKicadErc, runNgspice } from "../engineering/tools.js";
import { requiresFullEngineeringTools } from "../engineering/intent.js";
import { buildEngineeringWorkflowToolset } from "../engineering/workflow.js";
import {
  IPC,
  type ChatStreamEvent,
  type PendingEdit,
  type ProjectFileCorpusEntry,
  type PythonRunResult,
  type SemanticSearchHit
} from "../../shared/types.js";

export interface AgentSessionDeps {
  win: BrowserWindow;
  workspaceRoot: string;
  auditFilePath: string;
  relaunch: () => void;
  runPython: (code: string, args?: Record<string, unknown>) => Promise<PythonRunResult>;
  resetPython: () => void;
  semanticSearch: (query: string, corpus: ProjectFileCorpusEntry[], topK: number) => Promise<SemanticSearchHit[]>;
}

/**
 * Owns one conversation's history and wires the agent loop to the active
 * brain provider, the self-edit toolset, and the renderer. The provider is
 * re-resolved on every turn so a mid-conversation provider switch in
 * Settings takes effect on the very next message.
 */
export class AgentSession {
  private history: BrainMessage[] = [];
  private pendingApprovals = new Map<string, (decision: "approved" | "rejected") => void>();
  private auditLog: AuditLog;
  private activeTurnId = 0;
  private runningTurn = false;

  constructor(private deps: AgentSessionDeps) {
    this.auditLog = new AuditLog(deps.auditFilePath);
  }

  private sendStream(event: ChatStreamEvent): void {
    this.deps.win.webContents.send(IPC.chatStream, event);
  }

  resolveApproval(pendingId: string, decision: "approved" | "rejected"): void {
    const resolve = this.pendingApprovals.get(pendingId);
    if (resolve) {
      resolve(decision);
      this.pendingApprovals.delete(pendingId);
    }
  }

  listAudit() {
    return this.auditLog.list();
  }

  stop(): boolean {
    if (!this.runningTurn) return false;
    // Providers do not all expose an abortable streaming request. Advancing
    // this token stops the UI turn immediately and discards any late chunks.
    this.activeTurnId++;
    this.runningTurn = false;
    this.deps.win.webContents.send(IPC.faceState, "idle");
    return true;
  }

  async revertAudit(auditId: string) {
    const transaction = new SelfEditTransaction(this.deps.workspaceRoot, this.deps.auditFilePath);
    return transaction.revert(auditId);
  }

  async send(userText: string, attachments?: Attachment[]): Promise<void> {
    const { win, workspaceRoot, auditFilePath, relaunch, runPython, resetPython, semanticSearch } = this.deps;
    const turnId = ++this.activeTurnId;
    this.runningTurn = true;

    let provider;
    try {
      provider = await createBrainProvider();
    } catch (err) {
      if (turnId !== this.activeTurnId) return;
      this.runningTurn = false;
      this.sendStream({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const brainConfig = await loadBrainConfig();
    if (turnId !== this.activeTurnId) return;

    const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
    const gate: EditApprovalGate = {
      requestApproval: (pending: PendingEdit) =>
        new Promise((resolve) => {
          this.pendingApprovals.set(pending.id, resolve);
          this.sendStream({ type: "edit-pending", pending });
        })
    };

    // A 3B local model is reliable at conversation but not at choosing among
    // a full agent toolbox. Give it a single, explicit, validated workflow
    // only when the request clearly matches it. Larger local/cloud models
    // retain the complete toolset below.
    const tier = resolveToolTier(provider);
    if (tier === "core" && requiresFullEngineeringTools(userText)) {
      const message = "I cannot execute a full CAD or simulation engineering project with this small local model. Select a larger tool-capable model, then ask again; I will show each project, FreeCAD, and CalculiX tool action as it runs rather than claiming work was completed.";
      this.history.push({ role: "user", content: userText, attachments });
      this.history.push({ role: "assistant", content: message });
      this.runningTurn = false;
      win.webContents.send(IPC.faceState, "idle");
      this.sendStream({ type: "text-delta", text: message });
      this.sendStream({ type: "turn-done", fullText: message });
      return;
    }
    const selfEditEnabled = tier === "full";
    const selfEdit = selfEditEnabled
      ? buildSelfEditToolset({
          workspaceRoot,
          transaction,
          gate,
          getAutoApproveCoreEdits: async () => (await loadBrainConfig()).autoApproveCoreEdits,
          onCoreEditApplied: (commitSha) => {
            void applyCoreEditAndMaybeRestart(workspaceRoot, commitSha, relaunch).then((result) => {
              if (!result.ok) {
                this.sendStream({
                  type: "error",
                  message: `Core edit applied to the workspace but failed to build — the running app was not restarted:\n${result.error}`
                });
              }
            });
          }
        })
      : null;
    const persona = buildPersonaToolset({ workspaceRoot, transaction });
    const projects = buildProjectsToolset({ projectsRoot: defaultProjectsRoot(), semanticSearch });
    const compute = buildComputeToolset({ runPython, resetPython });
    const skills = buildSkillsToolset({ skillsRoot: defaultSkillsRoot(), runPython });
    const mac = buildMacToolset({ projectsRoot: defaultProjectsRoot(), open: openWithMac });
    const engineering = buildEngineeringToolset({ projectsRoot: defaultProjectsRoot(), runFreeCad: runFreeCadMacro, runCalculiX, runNgspice, runKicadErc, runKicadDrc });
    const workflow = buildEngineeringWorkflowToolset(defaultProjectsRoot());
    // Rebuilt fresh every turn (cheap — just a directory read per skill) so
    // a skill created mid-conversation via create_skill's parameters
    // argument is callable as its own tool on the very next turn, no
    // restart. This is the entire "the model can make a tool" mechanism.
    const dynamicSkills = await buildDynamicSkillTools({ skillsRoot: defaultSkillsRoot(), runPython });
    const fullDefs = [...(selfEdit?.defs ?? []), ...persona.defs, ...projects.defs, ...compute.defs, ...skills.defs, ...mac.defs, ...engineering.defs, ...workflow.defs, ...dynamicSkills.defs];
    const fullHandlers = {
      ...(selfEdit?.handlers ?? {}),
      ...persona.handlers,
      ...projects.handlers,
      ...compute.handlers,
      ...skills.handlers,
      ...mac.handlers,
      ...engineering.handlers,
      ...workflow.handlers,
      ...dynamicSkills.handlers
    };
    // Every dynamic skill_<name> tool is core-tier eligible regardless of
    // the fixed CORE_TOOL_NAMES allowlist — a skill the model just taught
    // itself should be usable right away, on any model, not walled off
    // until a bigger provider is selected.
    const isCoreEligible = (name: string) => CORE_TOOL_NAMES.has(name) || name.startsWith("skill_");
    const defs = tier === "core" ? fullDefs.filter((d) => isCoreEligible(d.name)) : fullDefs;
    const handlers =
      tier === "core"
        ? Object.fromEntries(Object.entries(fullHandlers).filter(([name]) => isCoreEligible(name)))
        : fullHandlers;

    // buildComposedSystemPrompt() is deliberately stable turn-to-turn (no
    // timestamp) so it stays a reusable prefix; time-varying context goes
    // on the user turn instead — see persona/compose.ts.
    const [system, turnContext] = await Promise.all([
      buildComposedSystemPrompt(
        workspaceRoot,
        provider.kind === "anthropic"
          ? undefined
          : tier === "core"
            ? {
                memoryMaxChars: LOCAL_MEMORY_INJECT_MAX_CHARS,
                dailyLogDays: LOCAL_DAILY_LOG_INJECT_DAYS,
                includeToolInstructions: true,
                includeSelfEditInstructions: false,
                includePersonaDocuments: false,
                toolTier: "core"
              }
            : {
              memoryMaxChars: LOCAL_MEMORY_INJECT_MAX_CHARS,
              dailyLogDays: LOCAL_DAILY_LOG_INJECT_DAYS,
              includeToolInstructions: true,
              includeSelfEditInstructions: selfEditEnabled,
              // Local models should spend their limited context on the task,
              // not a personality dossier. The compact base prompt still
              // identifies Mimir and preserves safe tool behavior.
              includePersonaDocuments: false
            }
      ),
      provider.kind === "anthropic" ? buildTurnContext() : Promise.resolve("")
    ]);

    this.history.push({
      role: "user",
      content: turnContext ? `${turnContext} ${userText}` : userText,
      attachments
    });
    win.webContents.send(IPC.faceState, "thinking");

    let assistantText = "";
    for await (const ev of runAgentTurn(this.history, {
      provider,
      system,
      tools: defs,
      handlers,
      effort: brainConfig.effort,
      webSearchEnabled: brainConfig.webSearchEnabled
    })) {
      if (turnId !== this.activeTurnId) return;
      if (ev.type === "text") {
        assistantText += ev.text;
        this.sendStream({ type: "text-delta", text: ev.text });
      } else if (ev.type === "tool-start") {
        win.webContents.send(IPC.faceState, "thinking");
        this.sendStream({ type: "tool-start", name: ev.name });
      } else if (ev.type === "tool-end") {
        this.sendStream({ type: "tool-end", name: ev.name, isError: ev.isError });
      } else if (ev.type === "tool-image") {
        this.sendStream({ type: "image", dataUrl: ev.dataUrl });
      } else if (ev.type === "error") {
        this.sendStream({ type: "error", message: ev.message });
      } else if (ev.type === "turn-done") {
        this.sendStream({ type: "turn-done", fullText: assistantText });
      }
    }

    if (turnId !== this.activeTurnId) return;
    this.runningTurn = false;

    win.webContents.send(IPC.faceState, "idle");
    // Keep only the true conversational history (loop() returns the full
    // tool-augmented transcript internally; we re-derive a compact form so
    // context doesn't balloon with every tool_result on long sessions).
    if (assistantText) {
      this.history.push({ role: "assistant", content: assistantText });
    }
  }
}

/** The fixed part of the "core" tier tool set — every model gets at least
 * this, never zero. Deliberately small: the repo has live-tested evidence
 * that offering llama3.2:3b the entire 30-tool surface made it emit
 * tool-call JSON into visible chat instead of using real tool_calls. Kept
 * in sync by hand with CORE_TOOLS_RULES in persona/compose.ts — that
 * prompt text must describe exactly this set, no more, no less. Every
 * parameterized skill's projected skill_<name> tool is core-eligible too,
 * but that's structural (see isCoreEligible below) rather than listed here
 * by name, since the set of skills changes at runtime. */
const CORE_TOOL_NAMES = new Set([
  "run_python",
  "create_skill",
  "list_skills",
  "run_skill",
  "list_project_files",
  "read_project_file",
  "write_project_file",
  "memory_replace"
]);

/** Two tool tiers, never zero tools. "full" is the complete 30-tool surface
 * plus self-edit — every non-Ollama provider, and an Ollama model whose tag
 * parses to more than 7B parameters. "core" is everything else: an Ollama
 * model at 7B or under, AND — this is a deliberate fix, not the original
 * behavior — an Ollama tag with no parseable size at all. Before this fix,
 * "llama3.2" (no explicit size) silently matched neither branch of the old
 * regex and fell through to the FULL toolset, while "llama3.2:3b" — the
 * identical weights — got zero tools. Absence of a size in the tag is not
 * evidence of a large model; treating it as "assume large" was the bug. */
export function resolveToolTier(provider: { kind: string; model: string }): "core" | "full" {
  if (provider.kind !== "ollama") return "full";
  const parameterCount = provider.model.match(/(?:^|[:_-])(\d+(?:\.\d+)?)b(?:$|[:_-])/i);
  if (!parameterCount) return "core";
  return Number(parameterCount[1]) > 7 ? "full" : "core";
}

/** Self-edit is the one capability gated a step earlier than the general
 * tier split — it's not just excluded from the core allowlist, its whole
 * toolset is never even constructed for a core-tier turn (see send()).
 * Equivalent to resolveToolTier(provider) === "full"; kept as its own named
 * export since skills/builtins.ts (the Skill Tree UI) checks this
 * specifically to decide whether to show the Self-Edit capability section. */
export function shouldEnableSelfEdit(provider: { kind: string; model: string }): boolean {
  return resolveToolTier(provider) === "full";
}
