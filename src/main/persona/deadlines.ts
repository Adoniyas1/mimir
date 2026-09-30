import { Notification } from "electron";
import { readPersonaFile } from "./compose.js";
import { loadPersonaConfig } from "./config.js";
import { readJsonFile, writeJsonFile } from "../config/store.js";
import { isoDate, parseDueTask, startOfDay, taskKey } from "./deadlineParsing.js";

const CHECK_INTERVAL_MS = 30 * 60_000; // deadline granularity is daily — no need to poll often
const DUE_SOON_DAYS = 3;
const STALE_OVERDUE_DAYS = 14; // stop nagging about something this old; likely already handled
const NOTIFY_STATE_FILE = "deadline-notify.json";

/** taskKey -> the ISO date (YYYY-MM-DD) it was last notified on. Kept out
 * of persona.json since it's pure bookkeeping, not a user-facing setting. */
type NotifyState = Record<string, string>;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodically scans TASKS.md for lines with a due date and fires an OS
 * notification for anything due soon or overdue — independent of the
 * memory-consolidation heartbeat (a different concern, on by default).
 * De-duped to at most one notification per task line per calendar day, so
 * it nudges as a deadline approaches without spamming. The actual
 * date/text parsing lives in deadlineParsing.ts so it's unit-testable
 * without an Electron runtime.
 */
export function startDeadlineNotifier(workspaceRoot: string): void {
  if (timer) return;
  timer = setInterval(() => void checkDeadlines(workspaceRoot), CHECK_INTERVAL_MS);
  setTimeout(() => void checkDeadlines(workspaceRoot), 10_000);
}

export function stopDeadlineNotifier(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function checkDeadlines(workspaceRoot: string): Promise<void> {
  try {
    const config = await loadPersonaConfig();
    if (!config.deadlineNotificationsEnabled) return;
    if (!Notification.isSupported()) return;

    const tasks = await readPersonaFile(workspaceRoot, "TASKS.md");
    if (!tasks.trim()) return;

    const today = startOfDay(new Date());
    const todayKey = isoDate(today);
    const state = await readJsonFile<NotifyState>(NOTIFY_STATE_FILE, {});
    let changed = false;

    for (const rawLine of tasks.split("\n")) {
      const due = parseDueTask(rawLine, today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
      if (!due) continue;

      const key = taskKey(due.line);
      if (state[key] === todayKey) continue; // already notified today

      new Notification({ title: "Mimir — deadline", body: due.label.slice(0, 200) }).show();
      state[key] = todayKey;
      changed = true;
    }

    if (changed) await writeJsonFile(NOTIFY_STATE_FILE, state);
  } catch (err) {
    console.warn("[mimir] deadline check failed:", err instanceof Error ? err.message : err);
  }
}
