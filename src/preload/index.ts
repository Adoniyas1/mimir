import { contextBridge, ipcRenderer } from "electron";

/**
 * The only surface the renderer can reach into the main process through.
 * contextIsolation is on and nodeIntegration is off (see main/index.ts) —
 * this is the sole bridge, and it's deliberately narrow: no raw ipcRenderer
 * access, no fs, no child_process. The renderer never gets a path that
 * could touch the self-edit workspace directly.
 *
 * The preload script is built as its own isolated CommonJS project (see
 * tsconfig.preload.json) — Electron loads preload scripts via `require()`
 * regardless of the app's "type": "module", so it can't share the ESM
 * output the rest of main/ uses. That isolation also means this file can't
 * *import* — even type-only — anything outside src/preload without
 * tripping a TS rootDir error, since preload is a single-file compilation
 * unit on purpose. So everything below is a deliberate, literal copy of
 * the shapes in src/shared/types.ts. Keep them in sync.
 */

type FaceState = "idle" | "listening" | "thinking" | "speaking" | "error";

interface Attachment {
  kind: "image" | "document" | "text";
  mimeType: string;
  data: string;
  name: string;
}

type EditTier = "skill" | "core" | "persona";

interface PendingEdit {
  id: string;
  summary: string;
  diff: string;
  filesTouched: string[];
  tier: EditTier;
}

type ChatStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
  | { type: "image"; dataUrl: string }
  | { type: "edit-pending"; pending: PendingEdit }
  | { type: "turn-done"; fullText: string }
  | { type: "error"; message: string };

type BrainProviderKind = "anthropic" | "openai-compatible" | "ollama";
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

interface BrainConfig {
  provider: BrainProviderKind;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  autoApproveCoreEdits: boolean;
  effort: EffortLevel;
  webSearchEnabled: boolean;
}

interface VoiceConfig {
  wakeWordEnabled: boolean;
  openMicEnabled: boolean;
  hasPicovoiceKey: boolean;
  ttsProvider: "system" | "elevenlabs";
  hasElevenLabsKey: boolean;
  elevenLabsVoiceId: string;
  systemVoice: string;
  wakeWordPath: string | null;
  followUpListenSeconds: number;
}

interface PersonaConfig {
  location: string | null;
  heartbeatEnabled: boolean;
  heartbeatIntervalMinutes: number;
  deadlineNotificationsEnabled: boolean;
}

interface AuditEntry {
  id: string;
  commitSha: string;
  parentSha: string;
  summary: string;
  tier: EditTier;
  filesTouched: string[];
  appliedAt: number;
  status: "applied" | "reverted";
}

interface PythonRunResult {
  stdout: string;
  result: string | null;
  error: string | null;
  images?: string[];
}

type PythonRunRequest = { id: string; code: string; args?: Record<string, unknown>; capabilities?: string[] } | { reset: true };

interface ProjectFileCorpusEntry {
  path: string;
  content: string;
  mtimeMs: number;
}

interface SemanticSearchHit {
  path: string;
  snippet: string;
  score: number;
}

interface SemanticSearchRequest {
  id: string;
  query: string;
  topK: number;
  corpus: ProjectFileCorpusEntry[];
}

type SkillStatus = "unverified" | "passed" | "failed";

interface SkillSummary {
  name: string;
  description: string;
  code: string;
  status: SkillStatus;
  verifiedAt: number | null;
  error: string | null;
  category: string;
  parent: string | null;
  hasParameters: boolean;
}

interface BuiltInCapability {
  name: string;
  description: string;
  category: string;
}

const IPC = {
  chatSend: "mimir:chat:send",
  chatStop: "mimir:chat:stop",
  chatStream: "mimir:chat:stream",
  chatSpeak: "mimir:chat:speak",
  faceState: "mimir:face:state",
  brainGetConfig: "mimir:brain:get-config",
  brainSetConfig: "mimir:brain:set-config",
  brainSetApiKey: "mimir:brain:set-api-key",
  brainListOllamaModels: "mimir:brain:list-ollama-models",
  voiceGetConfig: "mimir:voice:get-config",
  voiceSetConfig: "mimir:voice:set-config",
  voiceSetApiKey: "mimir:voice:set-api-key",
  voicePushToTalkStart: "mimir:voice:ptt-start",
  voicePushToTalkStop: "mimir:voice:ptt-stop",
  voiceWakeTriggered: "mimir:voice:wake-triggered",
  voiceHotkeyTriggered: "mimir:voice:hotkey-triggered",
  editApprove: "mimir:edit:approve",
  editReject: "mimir:edit:reject",
  auditList: "mimir:audit:list",
  auditRevert: "mimir:audit:revert",
  personaReset: "mimir:persona:reset",
  personaGetConfig: "mimir:persona:get-config",
  personaSetConfig: "mimir:persona:set-config",
  projectsGetRoot: "mimir:projects:get-root",
  projectsOpenFolder: "mimir:projects:open-folder",
  skillsGetRoot: "mimir:skills:get-root",
  skillsList: "mimir:skills:list",
  skillsListBuiltIns: "mimir:skills:list-builtins",
  skillsVerify: "mimir:skills:verify",
  skillsOpenFolder: "mimir:skills:open-folder",
  pythonRunRequest: "mimir:python:run-request",
  pythonRunResponse: "mimir:python:run-response",
  pythonHostCall: "mimir:python:host-call",
  semanticSearchRequest: "mimir:search:request",
  semanticSearchResponse: "mimir:search:response"
} as const;
const api = {
  chat: {
    send: (text: string, attachments?: Attachment[]) => ipcRenderer.send(IPC.chatSend, text, attachments),
    stop: () => ipcRenderer.send(IPC.chatStop),
    speak: (text: string) => ipcRenderer.invoke(IPC.chatSpeak, text),
    onStream: (cb: (event: ChatStreamEvent) => void) => {
      const listener = (_: unknown, event: ChatStreamEvent) => cb(event);
      ipcRenderer.on(IPC.chatStream, listener);
      return () => ipcRenderer.removeListener(IPC.chatStream, listener);
    }
  },
  face: {
    onState: (cb: (state: FaceState) => void) => {
      const listener = (_: unknown, state: FaceState) => cb(state);
      ipcRenderer.on(IPC.faceState, listener);
      return () => ipcRenderer.removeListener(IPC.faceState, listener);
    }
  },
  brain: {
    getConfig: (): Promise<BrainConfig> => ipcRenderer.invoke(IPC.brainGetConfig),
    setConfig: (patch: Partial<Omit<BrainConfig, "hasApiKey">>): Promise<BrainConfig> =>
      ipcRenderer.invoke(IPC.brainSetConfig, patch),
    setApiKey: (provider: BrainProviderKind, key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.brainSetApiKey, provider, key),
    listOllamaModels: (baseUrl?: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC.brainListOllamaModels, baseUrl)
  },
  voice: {
    getConfig: (): Promise<VoiceConfig> => ipcRenderer.invoke(IPC.voiceGetConfig),
    setConfig: (
      patch: Partial<
        Pick<VoiceConfig, "wakeWordEnabled" | "openMicEnabled" | "ttsProvider" | "elevenLabsVoiceId" | "systemVoice" | "wakeWordPath" | "followUpListenSeconds">
      >
    ): Promise<VoiceConfig> =>
      ipcRenderer.invoke(IPC.voiceSetConfig, patch),
    setApiKey: (kind: "picovoice" | "elevenlabs", key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.voiceSetApiKey, kind, key),
    pushToTalkStart: () => ipcRenderer.send(IPC.voicePushToTalkStart),
    pushToTalkStop: () => ipcRenderer.send(IPC.voicePushToTalkStop),
    onWakeTriggered: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.voiceWakeTriggered, listener);
      return () => ipcRenderer.removeListener(IPC.voiceWakeTriggered, listener);
    },
    onHotkeyTriggered: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.voiceHotkeyTriggered, listener);
      return () => ipcRenderer.removeListener(IPC.voiceHotkeyTriggered, listener);
    }
  },
  edit: {
    approve: (pendingId: string) => ipcRenderer.send(IPC.editApprove, pendingId),
    reject: (pendingId: string) => ipcRenderer.send(IPC.editReject, pendingId)
  },
  audit: {
    list: (): Promise<AuditEntry[]> => ipcRenderer.invoke(IPC.auditList),
    revert: (auditId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.auditRevert, auditId)
  },
  persona: {
    reset: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.personaReset),
    getConfig: (): Promise<PersonaConfig> => ipcRenderer.invoke(IPC.personaGetConfig),
    setConfig: (patch: Partial<PersonaConfig>): Promise<PersonaConfig> =>
      ipcRenderer.invoke(IPC.personaSetConfig, patch)
  },
  projects: {
    getRoot: (): Promise<string> => ipcRenderer.invoke(IPC.projectsGetRoot),
    openFolder: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.projectsOpenFolder)
  },
  skills: {
    getRoot: (): Promise<string> => ipcRenderer.invoke(IPC.skillsGetRoot),
    list: (): Promise<SkillSummary[]> => ipcRenderer.invoke(IPC.skillsList),
    listBuiltIns: (): Promise<BuiltInCapability[]> => ipcRenderer.invoke(IPC.skillsListBuiltIns),
    verify: (name: string): Promise<SkillSummary | null> => ipcRenderer.invoke(IPC.skillsVerify, name),
    openFolder: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.skillsOpenFolder)
  },
  python: {
    onRunRequest: (cb: (req: PythonRunRequest) => void) => {
      const listener = (_: unknown, req: PythonRunRequest) => cb(req);
      ipcRenderer.on(IPC.pythonRunRequest, listener);
      return () => ipcRenderer.removeListener(IPC.pythonRunRequest, listener);
    },
    sendResult: (id: string, result: PythonRunResult) =>
      ipcRenderer.send(IPC.pythonRunResponse, { id, ...result }),
    /** A running skill's Python code called a declared host capability
     * (see compute/hostCapabilities.ts) — request/reply, correlated by
     * Electron's own invoke/handle, no manual id tracking needed here. */
    hostCall: (
      capability: string,
      args: Record<string, unknown>,
      declaredCapabilities: string[]
    ): Promise<{ content?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.pythonHostCall, { capability, args, declaredCapabilities })
  },
  search: {
    onSearchRequest: (cb: (req: SemanticSearchRequest) => void) => {
      const listener = (_: unknown, req: SemanticSearchRequest) => cb(req);
      ipcRenderer.on(IPC.semanticSearchRequest, listener);
      return () => ipcRenderer.removeListener(IPC.semanticSearchRequest, listener);
    },
    sendResult: (id: string, hits: SemanticSearchHit[]) =>
      ipcRenderer.send(IPC.semanticSearchResponse, { id, hits })
  }
};

contextBridge.exposeInMainWorld("mimir", api);

export type MimirApi = typeof api;
