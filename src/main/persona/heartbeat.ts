import { createBrainProvider } from "../brain/index.js";
import { runAgentTurn } from "../agent/loop.js";
import { SelfEditTransaction } from "../self-edit/transaction.js";
import { buildPersonaToolset } from "./tools.js";
import { readPersonaFile, readRecentDailyLogs } from "./compose.js";
import { loadPersonaConfig, savePersonaConfig } from "./config.js";

const CHECK_INTERVAL_MS = 60_000; // check once a minute whether a heartbeat is actually due

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Background memory-consolidation pass, mirroring OmniBot's heartbeat_service.py:
 * periodically read recent daily logs and let the model rewrite MEMORY.md —
 * and ONLY MEMORY.md — with anything worth keeping long-term. Runs silently;
 * nothing is streamed to the chat UI.
 */
export function startHeartbeatScheduler(workspaceRoot: string, auditFilePath: string): void {
  if (timer) return;
  timer = setInterval(() => {
    void maybeRunHeartbeat(workspaceRoot, auditFilePath);
  }, CHECK_INTERVAL_MS);
  // Also check shortly after startup, in case the app was closed through a whole interval.
  setTimeout(() => void maybeRunHeartbeat(workspaceRoot, auditFilePath), 5_000);
}

export function stopHeartbeatScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function maybeRunHeartbeat(workspaceRoot: string, auditFilePath: string): Promise<void> {
  const config = await loadPersonaConfig();
  if (!config.heartbeatEnabled) return;
  const dueAt = (config.lastHeartbeatAt ?? 0) + config.heartbeatIntervalMinutes * 60_000;
  if (Date.now() < dueAt) return;

  try {
    await runHeartbeatPass(workspaceRoot, auditFilePath);
  } catch (err) {
    console.warn("[mimir] heartbeat pass failed:", err instanceof Error ? err.message : err);
  } finally {
    await savePersonaConfig({ lastHeartbeatAt: Date.now() });
  }
}

/** Tools this restricted pass is allowed to call — memory consolidation
 * plus tasks/deadlines review, nothing else (see runHeartbeatPass). */
const HEARTBEAT_TOOL_NAMES = ["memory_replace", "tasks_replace"] as const;

async function runHeartbeatPass(workspaceRoot: string, auditFilePath: string): Promise<void> {
  const provider = await createBrainProvider();
  // A restricted maintenance pass needs real tool-calling to actually write
  // MEMORY.md/TASKS.md — skip rather than degrade through the ReAct shim,
  // since a shimmed model silently no-op-ing here is worse than not running.
  if (!provider.supportsTools()) return;

  const [dailyLogs, heartbeatInstructions, tasks] = await Promise.all([
    readRecentDailyLogs(workspaceRoot),
    readPersonaFile(workspaceRoot, "HEARTBEAT.md").then((s) => s.trim()),
    readPersonaFile(workspaceRoot, "TASKS.md").then((s) => s.trim())
  ]);
  if (!dailyLogs.trim() && !tasks) return; // nothing to consolidate or review

  const system = [
    "You are Mimir's background maintenance process, not a conversation partner. This pass runs " +
      `unattended at ${new Date().toDateString()}. Your job: consolidate the daily logs below into MEMORY.md ` +
      "if there's anything worth keeping long-term, and review TASKS.md for anything done or past its " +
      "deadline with no follow-up mentioned. You may call memory_replace and/or tasks_replace, each at most " +
      "once. If nothing needs to change, don't call anything.",
    heartbeatInstructions ? `Instructions:\n\n${heartbeatInstructions}` : "",
    tasks ? `Current TASKS.md:\n\n${tasks}` : "",
    dailyLogs.trim() ? `Recent daily logs:\n\n${dailyLogs}` : ""
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const transaction = new SelfEditTransaction(workspaceRoot, auditFilePath);
  const persona = buildPersonaToolset({ workspaceRoot, transaction });
  const allowedDefs = persona.defs.filter((d) => (HEARTBEAT_TOOL_NAMES as readonly string[]).includes(d.name));
  const allowedHandlers: Record<string, (typeof persona.handlers)[string]> = {};
  for (const name of HEARTBEAT_TOOL_NAMES) {
    const handler = persona.handlers[name];
    if (handler) allowedHandlers[name] = handler;
  }

  const history = [
    { role: "user" as const, content: "Run your maintenance pass now: consolidate memory and review tasks, if warranted." }
  ];

  for await (const _ev of runAgentTurn(history, {
    provider,
    system,
    tools: allowedDefs,
    handlers: allowedHandlers,
    maxToolIterations: 3
  })) {
    // Background pass — intentionally not streamed to the renderer.
  }
}
