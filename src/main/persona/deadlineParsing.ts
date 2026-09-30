/**
 * Pure date/text logic for deadline notifications, kept free of any
 * "electron" import so it's unit-testable in plain Node — deadlines.ts
 * (which does import electron's Notification) is the thin wrapper around
 * this that vitest can't easily exercise directly.
 */

// TASKS.md is freeform markdown the model writes; ISO dates are the one
// format worth parsing reliably rather than guessing at "next Friday" —
// the persona prompt nudges the model to use this format for real deadlines.
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

export interface DueTask {
  line: string;
  daysUntil: number;
  label: string;
}

/** Local-calendar YYYY-MM-DD — deliberately not toISOString(), which
 * normalizes to UTC and shifts the date for timezones east of UTC. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Cheap stable de-dupe key — doesn't need to be cryptographic, just
 * consistent for the same line across checks. */
export function taskKey(line: string): string {
  let hash = 0;
  for (let i = 0; i < line.length; i++) hash = (hash * 31 + line.charCodeAt(i)) | 0;
  return String(hash);
}

/** Parses one TASKS.md line into a due-task record, or null if it isn't a
 * dated, unchecked line within the notification window. `today` should
 * already be startOfDay()'d. */
export function parseDueTask(rawLine: string, today: Date, dueSoonDays: number, staleOverdueDays: number): DueTask | null {
  const line = rawLine.trim();
  if (!line || /\[x\]/i.test(line)) return null; // blank or already checked off

  const match = line.match(DATE_RE);
  if (!match?.[1]) return null;
  const due = new Date(`${match[1]}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;

  const daysUntil = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (daysUntil > dueSoonDays || daysUntil < -staleOverdueDays) return null;

  const label =
    daysUntil < 0
      ? `Overdue by ${-daysUntil} day${daysUntil === -1 ? "" : "s"}: ${line}`
      : daysUntil === 0
        ? `Due today: ${line}`
        : `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}: ${line}`;

  return { line, daysUntil, label };
}
