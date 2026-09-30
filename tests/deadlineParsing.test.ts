import { describe, it, expect } from "vitest";
import { isoDate, parseDueTask, startOfDay, taskKey } from "../src/main/persona/deadlineParsing.js";

const DUE_SOON_DAYS = 3;
const STALE_OVERDUE_DAYS = 14;

describe("deadlineParsing", () => {
  const today = startOfDay(new Date("2026-08-10T15:30:00"));

  it("parses a due-soon task and labels the days remaining", () => {
    const result = parseDueTask("- Lab 3 report due 2026-08-12", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result).not.toBeNull();
    expect(result?.daysUntil).toBe(2);
    expect(result?.label).toMatch(/Due in 2 days/);
  });

  it("labels a same-day deadline as due today", () => {
    const result = parseDueTask("- Problem set 2026-08-10", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result?.daysUntil).toBe(0);
    expect(result?.label).toMatch(/Due today/);
  });

  it("labels a past date as overdue", () => {
    const result = parseDueTask("- Quiz 2026-08-08", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result?.daysUntil).toBe(-2);
    expect(result?.label).toMatch(/Overdue by 2 days/);
  });

  it("ignores a checked-off task even if the date is due soon", () => {
    const result = parseDueTask("- [x] Lab 3 report due 2026-08-12", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result).toBeNull();
  });

  it("ignores a line with no date", () => {
    const result = parseDueTask("- Talk to advisor about thesis topic", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result).toBeNull();
  });

  it("ignores a deadline further out than the due-soon window", () => {
    const result = parseDueTask("- Final project due 2026-09-01", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result).toBeNull();
  });

  it("stops surfacing something overdue past the stale window", () => {
    const result = parseDueTask("- Old reading response 2026-07-01", today, DUE_SOON_DAYS, STALE_OVERDUE_DAYS);
    expect(result).toBeNull();
  });

  it("produces a stable local-calendar ISO date regardless of time-of-day", () => {
    expect(isoDate(new Date("2026-08-10T23:59:00"))).toBe(isoDate(new Date("2026-08-10T00:01:00")));
  });

  it("produces the same de-dupe key for the same line", () => {
    expect(taskKey("- Lab 3 report due 2026-08-12")).toBe(taskKey("- Lab 3 report due 2026-08-12"));
    expect(taskKey("- Lab 3 report due 2026-08-12")).not.toBe(taskKey("- Lab 4 report due 2026-08-12"));
  });
});
