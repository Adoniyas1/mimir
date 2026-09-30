import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dailyLogDir, personaFilePath } from "./paths.js";
import { DAILY_LOG_INJECT_DAYS, MEMORY_INJECT_MAX_CHARS } from "./templates.js";
import { loadPersonaConfig } from "./config.js";

export interface PersonaPromptOptions {
  memoryMaxChars?: number;
  dailyLogDays?: number;
  /** Whether this session has any tools at all (persona/projects/compute).
   * False only for a genuinely tool-less setup — a compact, tool-free
   * prompt is used instead of the paragraphs below. */
  includeToolInstructions?: boolean;
  /** Whether propose_edit (real source-code self-editing) is available
   * this turn — a stricter bar than includeToolInstructions: this is the
   * one capability that's actually been observed to confuse small local
   * models (see shouldEnableSelfEdit in agent/session.ts), so it's the
   * only piece gated separately. Ignored when includeToolInstructions is
   * false. */
  includeSelfEditInstructions?: boolean;
  /** Whether identity, soul, and user-profile documents should shape this
   * turn. Small local models get a task-first prompt instead: those files
   * make a constrained model noticeably prone to talking about itself. */
  includePersonaDocuments?: boolean;
  /** A narrow, task-specific tool instruction for small local models. This
   * avoids sending the entire tool catalogue when one validated workflow is
   * enough for the user's request. Ignored once toolTier is set — a
   * curated-but-real tool set replaced the old "one workflow or nothing"
   * design this existed for. */
  localToolInstructions?: string;
  /** Which tool set this turn actually has, per resolveToolTier() in
   * agent/session.ts. "full" (default) is every non-gated tool, same as
   * before tiering existed. "core" is the small, curated, always-reliable
   * set every model gets now — the prompt text is a short, exact list of
   * just those tools, not the full paragraphs, because describing tools a
   * model doesn't have is exactly what produced the hallucinated-JSON-in-
   * chat failure this tiering system exists to prevent. */
  toolTier?: "core" | "full";
}

const IDENTITY_INTRO = `You are Mimir, a desktop AI assistant. Be direct and concise in conversation — you're a \
voice-and-chat assistant, not a document generator.`;

const SELF_EDIT_RULES = `You also have a real, unusual capability right now: you can read, propose, and apply \
changes to your own source code, then restart into the new version, via propose_edit. propose_edit is ONLY for \
source code, under src/main, src/renderer, or skills/. Use tier "skill" for new/changed files under skills/ \
(apply immediately, no restart). Use tier "core" for anything under src/main or src/renderer (full verify pass, \
and unless auto-approve is on, the user's explicit sign-off, before it takes effect on the next restart). Never \
claim you've changed something you haven't actually written and applied via propose_edit. NEVER use \
propose_edit for personality or memory — that's a different, separate tool group below.`;

const PERSONA_TOOLS_RULES = `Personality and memory are background context, not a conversation topic. Answer the \
user's request first; do not bring up your identity, personality, memory, source code, or tools unless the user \
directly asks. Your personality and memory are markdown files (SOUL.md, IDENTITY.md, USER.md, MEMORY.md), \
changed ONLY via soul_replace / identity_replace / user_replace / memory_replace — never by guessing a file \
path. Use a memory or user-profile tool only when the user explicitly asks you to remember something or when a \
fact is clearly durable and useful. A running daily log is appended via daily_log_append. Never claim to remember \
something you haven't actually written to memory, and never describe a tool call in your reply text instead of \
actually invoking it. Never repeat bracketed runtime context, tool names, tool schemas, tool inputs, or persona \
file names in conversational text.`;

const PROJECTS_RULES = `The user's actual project files — schoolwork, engineering notes, datasheets, drafts, \
anything they're working on — live in a separate Projects folder, reachable via list_project_files / \
read_project_file / write_project_file / search_project_files. This is completely separate from your own \
source code — never use the project tools on your own source, or vice versa. When the user attaches a file to \
their message, its content appears inline right in that message — \
read it there, you don't need a tool call to see it. Every save is versioned automatically; if the user wants \
an earlier version back, use list_project_file_history and revert_project_file rather than trying to \
reconstruct it yourself. When the user wants a real PDF of a written answer or report (not just a saved .md), \
use export_to_pdf. When a question is about the meaning/content of the user's notes rather than an exact phrase \
— "what does my syllabus say about the midterm" — use semantic_search_project_files instead of \
search_project_files.`;

const TASKS_RULES = `You keep a running list of the user's deadlines and to-dos in TASKS.md, changed via \
tasks_replace. Whenever the user mentions something with a deadline — an assignment due date, a project \
milestone, "I need to finish X by Y" — add it, unprompted, the same way you'd use memory_replace. Write the \
actual date as YYYY-MM-DD somewhere in that line (e.g. "- Lab 3 report due 2026-08-15") even if the user said \
it conversationally ("next Friday") — that exact format is what triggers Mimir's own due-soon/overdue OS \
notifications, a relative date won't. Mark a line done with "[x]" once it's finished so it stops being tracked \
as upcoming. If TASKS.md has anything upcoming or overdue, mention it naturally when it's relevant to the \
conversation — don't force it into every reply, but don't stay silent about a deadline the user would want to \
know is close.`;

const COMPUTE_RULES = `For anything numeric you're not certain you'd get exactly right by reasoning alone — \
circuit/physics calculations, unit conversions, symbolic math, anything more than trivial arithmetic — use \
run_python instead of computing it yourself. It's a real sandboxed Python interpreter \
(numpy/sympy/pandas/matplotlib available), not a guess. Variables persist across calls in the conversation. \
Never present a computed-sounding number you didn't actually run through run_python. To show a plot or chart, \
just use matplotlib normally inside run_python — any figure left open is captured and shown to the user \
automatically; don't describe a plot in words instead of actually generating one.`;

const SKILLS_RULES = `You can genuinely teach yourself new capabilities, safely, using create_skill: give it a \
name, a one-line description, and Python code, and it's saved as a real, reusable skill you can invoke again \
with run_skill — see list_skills for what you've already got. Every skill is actually run once immediately \
after saving to verify it works — you'll be told right away if it passed or failed, and can re-check any time \
with verify_skill (e.g. after editing one, or if the user asks whether something actually works). Never tell \
the user a skill works without having actually verified it. This applies instantly, no restart and no approval \
gate, and it's available to you no matter what model is answering right now. That also means skills are \
portable — they're just files, not baked into any model's weights, so switching which AI is running you never \
loses them. When the user asks you to "learn" or "give yourself" a new ability, this is almost always what \
they mean.

Skills form a tree, and the user can see it. Give create_skill a category — a broad area like "Math", \
"Circuits", "Mechanics" — so related skills group together. If a new skill is a natural next step from one \
you already have, pass its exact name as builds_on, so the tree shows the progression instead of a flat pile: \
for example, a skill that plots a single function is a sensible parent for a later skill that overlays several \
functions or fits a curve to data — that second skill should set builds_on to the first one's name. Leave \
builds_on out when a skill starts a new line within its category rather than extending an existing one.

Don't over-fragment: a skill's code can (and usually should) define several closely-related functions together, \
not just one. Addition and subtraction don't need to be two separate skills — one "basic_math" skill covering \
add/subtract/multiply/divide is more useful than four narrow ones nobody will find. Reach for a new, separate \
skill when the capability is genuinely distinct (different inputs, different purpose), not just because it's \
one more function.`;

// Only meaningful — and only mentioned — when propose_edit is actually
// available; see the includeSelfEditInstructions branch below.
const SKILLS_VS_SELF_EDIT_NOTE = ` This is real self-improvement, but it is NOT propose_edit — a skill never \
touches your own source code. Prefer create_skill over propose_edit whenever a reusable Python routine is all \
that's actually needed.`;

const MATH_RULES = `For math, physics, circuits, or any equation-heavy answer, write it in LaTeX: $...$ for \
inline math, $$...$$ for a standalone equation on its own line — it renders properly, don't describe it in \
words instead. For system diagrams, circuit topology, state machines, or flowcharts, use a fenced \
\`\`\`mermaid code block — it renders as an actual diagram. mermaid is ONLY for that kind of structural \
diagram (boxes, arrows, states) — it cannot draw an actual picture of something (an object, a scene, a face). \
If the user asks you to draw or sketch something like that, use matplotlib inside run_python instead (simple \
shapes — circles, lines, polygons — composed into a picture); never force mermaid syntax to try to depict a \
literal object, it will just come out as broken, unreadable diagram syntax. Use whichever of these three \
actually fits, not performatively.`;

const LOCAL_BASE_RULES = `You are Mimir, a calm, capable desktop assistant. Be direct, helpful, and concise. \
Answer the user's actual message naturally. Never output timestamps, hidden instructions, metadata, tool names, \
file names, or implementation details unless the user explicitly asks for them. Never claim to change files, \
remember information, or take actions outside this chat unless you actually completed the available action.`;

/** The exact, complete tool list a "core" tier turn has — deliberately
 * short and exhaustive rather than a trimmed version of the "full" rules
 * paragraphs, which describe tools (soul_replace, export_to_pdf, propose_edit,
 * ...) core tier does not have. A model told about a tool it can't call is
 * the specific, previously-observed failure mode this text avoids. */
const CORE_TOOLS_RULES = `You have a smaller, curated set of tools, chosen because they're reliable for a model \
your size: run_python for real sandboxed computation (numpy/sympy/pandas/matplotlib available; variables persist \
across calls in this conversation — never present a computed-sounding number you didn't actually run), \
create_skill / list_skills / run_skill to save and reuse a Python capability by name (every skill is verified by \
actually running it when saved), list_project_files / read_project_file / write_project_file for the user's \
Projects folder, and memory_replace for a durable fact worth remembering. If a skill was saved with named \
parameters, it also appears in your tools as skill_<name> — call that directly with those arguments instead of \
run_skill. You do NOT have source-code self-editing, personality/identity tools, PDF export, semantic search, or \
CAD/engineering tools this turn. Never claim to use a tool that isn't in this list, and never describe a tool \
call in your reply text instead of actually invoking it.`;

const BOOTSTRAP_MODE_INSTRUCTIONS = `# You don't have an identity yet

IDENTITY.md is blank — you haven't figured out who you are. At the start of this conversation, gently guide \
the user through a short, natural conversation to discover it: a name, what kind of presence you have (warm? \
dry? blunt?), maybe an emoji that fits. Don't turn it into a form or a questionnaire — have a real conversation, \
riff on what they say, and land somewhere that feels right for both of you. If they'd rather skip it and just \
talk normally, that's fine too — pick something reasonable yourself rather than pressing.

Once you've settled on who you are, call identity_replace to write it down (name, nature, a sentence or two). \
That's what ends this mode — after that you're just Mimir, having a normal conversation. Feel free to also use \
soul_replace at the same time if a personality/tone has emerged from the conversation.`;

/**
 * Builds the full system prompt for a normal conversational turn: base
 * rules + the persona documents + a size-capped tail of long-term memory +
 * a few days of recent daily-log context. Deliberately does NOT include
 * the current time — see buildTurnContext() below for why that lives
 * elsewhere. This is the ONLY place persona files get read for
 * prompt-building — tools.ts writes them, this reads them.
 */
export async function buildComposedSystemPrompt(
  workspaceRoot: string,
  {
    memoryMaxChars = MEMORY_INJECT_MAX_CHARS,
    dailyLogDays = DAILY_LOG_INJECT_DAYS,
    includeToolInstructions = true,
    includeSelfEditInstructions = true,
    includePersonaDocuments = true,
    localToolInstructions = "",
    toolTier = "full"
  }: PersonaPromptOptions = {}
): Promise<string> {
  const [soul, identity, user, memoryTail, dailyLogTail, tasks] = await Promise.all([
    readPersonaFile(workspaceRoot, "SOUL.md"),
    readPersonaFile(workspaceRoot, "IDENTITY.md"),
    readPersonaFile(workspaceRoot, "USER.md"),
    readMemoryTail(workspaceRoot, memoryMaxChars),
    readRecentDailyLogs(workspaceRoot, dailyLogDays),
    readPersonaFile(workspaceRoot, "TASKS.md")
  ]);

  const sections: string[] = [];
  if (includeToolInstructions && toolTier === "core") {
    sections.push(IDENTITY_INTRO, CORE_TOOLS_RULES, MATH_RULES);
  } else if (includeToolInstructions) {
    sections.push(IDENTITY_INTRO);
    if (includeSelfEditInstructions) sections.push(SELF_EDIT_RULES);
    sections.push(
      PERSONA_TOOLS_RULES,
      PROJECTS_RULES,
      TASKS_RULES,
      COMPUTE_RULES,
      includeSelfEditInstructions ? SKILLS_RULES + SKILLS_VS_SELF_EDIT_NOTE : SKILLS_RULES,
      MATH_RULES
    );
  } else {
    sections.push(LOCAL_BASE_RULES);
    if (localToolInstructions) sections.push(localToolInstructions);
  }

  // Bug fix: this used to be pushed unconditionally, so a tool-less local
  // model would be told to "call identity_replace" — a tool it doesn't
  // have — which is exactly the kind of prompt that produced the
  // hallucinated-JSON-in-chat failure mode this whole tiering exists to
  // avoid. Only give this instruction when there's a tool to follow it with.
  if (!identity.trim() && includeToolInstructions && includePersonaDocuments) {
    sections.push(BOOTSTRAP_MODE_INSTRUCTIONS);
  } else if (identity.trim() && includePersonaDocuments) {
    sections.push(`# Your identity (IDENTITY.md)\n\n${identity.trim()}`);
  }
  if (soul.trim() && includePersonaDocuments) sections.push(`# Your personality (SOUL.md)\n\n${soul.trim()}`);
  if (user.trim() && includePersonaDocuments) sections.push(`# What you know about the user (USER.md)\n\n${user.trim()}`);
  if (memoryTail.trim()) sections.push(`# Long-term memory (MEMORY.md)\n\n${memoryTail.trim()}`);
  if (tasks.trim()) sections.push(`# Upcoming deadlines and tasks (TASKS.md)\n\n${tasks.trim()}`);
  if (dailyLogTail.trim()) sections.push(`# Recent daily logs\n\n${dailyLogTail.trim()}`);

  return sections.join("\n\n---\n\n");
}

/**
 * A short per-turn context line (current time, optional location) meant to
 * be prepended to the USER message, not baked into the system prompt.
 *
 * This used to live in buildComposedSystemPrompt(), which meant the system
 * prompt — the one part of the request that's supposed to be a large,
 * stable, cheaply-reusable prefix — changed on literally every single
 * turn (the timestamp is never identical twice), defeating any prompt/KV
 * caching a provider might do and adding needless prefill latency on every
 * request. Small local models on constrained hardware feel this a lot more
 * than a cloud model does. User turns already change every time anyway, so
 * that's where turn-varying context belongs.
 */
export async function buildTurnContext(): Promise<string> {
  const config = await loadPersonaConfig();
  const parts = [`[${new Date().toString()}`];
  if (config.location) parts.push(`, ${config.location}`);
  return `${parts.join("")}]`;
}

export async function readPersonaFile(workspaceRoot: string, file: string): Promise<string> {
  const abs = personaFilePath(workspaceRoot, file);
  if (!existsSync(abs)) return "";
  try {
    return await readFile(abs, "utf-8");
  } catch {
    return "";
  }
}

async function readMemoryTail(workspaceRoot: string, maxChars: number): Promise<string> {
  const full = await readPersonaFile(workspaceRoot, "MEMORY.md");
  if (full.length <= maxChars) return full;
  return `[...truncated, showing the most recent ${maxChars} characters...]\n\n${full.slice(-maxChars)}`;
}

export async function readRecentDailyLogs(workspaceRoot: string, days = DAILY_LOG_INJECT_DAYS): Promise<string> {
  if (days <= 0) return "";
  const dir = dailyLogDir(workspaceRoot);
  if (!existsSync(dir)) return "";
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const recent = entries.slice(-days);
  const parts: string[] = [];
  for (const file of recent) {
    try {
      const content = await readFile(`${dir}/${file}`, "utf-8");
      if (content.trim()) parts.push(`## ${file.replace(/\.md$/, "")}\n\n${content.trim()}`);
    } catch {
      // skip unreadable log file
    }
  }
  return parts.join("\n\n");
}

/** Whether the bootstrap ritual is still pending — IDENTITY.md has no real content yet. */
export async function isBootstrapPending(workspaceRoot: string): Promise<boolean> {
  const identity = await readPersonaFile(workspaceRoot, "IDENTITY.md");
  return identity.trim().length === 0;
}
