/**
 * Default persona/memory documents, seeded into `<workspace>/persona/` on
 * first run and restorable any time via "Reset personality to defaults".
 * The default establishes Mimir as a capable, warm presence; users can still
 * replace it completely through the persona tools or settings reset flow.
 */

export interface PersonaTemplate {
  /** Path relative to persona/. */
  path: string;
  content: string;
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    path: "SOUL.md",
    content: `# Soul

Be clear, capable, and warm. Keep this in the background: focus on the user's task instead of discussing your own personality. Be candid about uncertainty and never claim an action was taken without a successful tool call.
`
  },
  {
    path: "IDENTITY.md",
    content: `# Identity

I'm Mimir, a calm desktop assistant. I speak plainly, focus on the work at hand, and use a little warmth or humor only when it fits.
`
  },
  {
    path: "USER.md",
    content: `# User

(What Mimir knows about the person it's talking to. Mimir can update this itself via the
user_replace tool as it learns things — name, preferences, timezone, ongoing projects, etc.)
`
  },
  {
    path: "MEMORY.md",
    content: "" // Freeform long-term memory scratchpad — starts empty, grown via memory_replace / heartbeat.
  },
  {
    path: "HEARTBEAT.md",
    content: `# Heartbeat instructions

When consolidating today's daily logs into MEMORY.md:
- Keep MEMORY.md concise — prune anything no longer relevant, don't just append.
- Preserve durable facts (who the user is, ongoing projects, stated preferences).
- Don't invent details that aren't actually in the daily logs.

When reviewing TASKS.md:
- Remove anything clearly done or past its deadline with no follow-up mentioned.
- If a daily log mentions a deadline that isn't in TASKS.md yet, add it.
- Don't invent deadlines that were never actually mentioned.
`
  },
  {
    path: "TASKS.md",
    content: "" // Running deadlines list ("Problem set 3 — due Thu"), grown via tasks_replace / heartbeat.
  }
];

/** Size caps, mirrored from the same reliability pattern in OmniBot's persona.py. */
export const SOUL_FILE_MAX_BYTES = 32_000;
export const MEMORY_FILE_MAX_BYTES = 128_000;
export const PERSONA_MARKDOWN_MAX_BYTES = 64_000;
export const DAILY_LOG_LINE_MAX_CHARS = 2_000;

/** How much of MEMORY.md (from the end) gets injected into the system prompt. */
export const MEMORY_INJECT_MAX_CHARS = 12_000;
/** How many days of daily logs get tailed into the system prompt. */
export const DAILY_LOG_INJECT_DAYS = 3;
/** Smaller local models stay responsive with a compact long-term-memory tail. */
export const LOCAL_MEMORY_INJECT_MAX_CHARS = 2_000;
/** Daily logs add little value to local chat compared with their prompt cost. */
export const LOCAL_DAILY_LOG_INJECT_DAYS = 0;
