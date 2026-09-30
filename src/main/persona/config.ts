import { readJsonFile, writeJsonFile } from "../config/store.js";

const FILE = "persona.json";

export interface PersonaConfig {
  /** Free-text location/timezone label injected into the system prompt, e.g. "Seattle, WA (PT)". */
  location: string | null;
  heartbeatEnabled: boolean;
  heartbeatIntervalMinutes: number;
  /** Epoch ms of the last heartbeat pass, so the scheduler survives restarts
   * without immediately re-running on every launch. Not user-facing. */
  lastHeartbeatAt: number | null;
  /** OS notifications for deadlines in TASKS.md due soon or overdue. On by
   * default — off is one checkbox away for anyone who finds it noisy. */
  deadlineNotificationsEnabled: boolean;
}

const DEFAULTS: PersonaConfig = {
  location: null,
  heartbeatEnabled: false,
  heartbeatIntervalMinutes: 60,
  lastHeartbeatAt: null,
  deadlineNotificationsEnabled: true
};

export async function loadPersonaConfig(): Promise<PersonaConfig> {
  return readJsonFile<PersonaConfig>(FILE, DEFAULTS);
}

export async function savePersonaConfig(patch: Partial<PersonaConfig>): Promise<PersonaConfig> {
  const current = await loadPersonaConfig();
  const next = { ...current, ...patch };
  await writeJsonFile(FILE, next);
  return next;
}
