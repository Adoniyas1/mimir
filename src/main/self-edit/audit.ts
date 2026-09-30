import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { AuditEntry } from "../../shared/types.js";

/**
 * Append-only-ish log of every self-edit that was actually applied
 * (verify steps that failed never reach here — see transaction.ts). Backed
 * by a plain JSON file so it's easy to inspect and doesn't need a DB
 * dependency for what is, at most, a few thousand entries over the app's
 * lifetime.
 */
export class AuditLog {
  constructor(private filePath: string) {}

  async list(): Promise<AuditEntry[]> {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as AuditEntry[];
    } catch {
      return [];
    }
  }

  async append(entry: AuditEntry): Promise<void> {
    const entries = await this.list();
    entries.push(entry);
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), "utf-8");
  }

  async markReverted(id: string): Promise<void> {
    const entries = await this.list();
    const target = entries.find((e) => e.id === id);
    if (target) target.status = "reverted";
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), "utf-8");
  }

  async get(id: string): Promise<AuditEntry | undefined> {
    return (await this.list()).find((e) => e.id === id);
  }
}
