import { app, BrowserWindow, globalShortcut, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapWorkspace, defaultAuditFilePath, defaultWorkspaceRoot } from "./self-edit/workspace.js";
import { AgentSession } from "./agent/session.js";
import { reportHealthy } from "./health.js";
import { IPC } from "../shared/types.js";
import type {
  Attachment,
  BrainConfig,
  BrainProviderKind,
  BuiltInCapability,
  PersonaConfig,
  ProjectFileCorpusEntry,
  PythonRunResult,
  SemanticSearchHit,
  SkillSummary,
  VoiceConfig
} from "../shared/types.js";
import { loadBrainConfig, saveBrainConfig, setBrainApiKey } from "./brain/config.js";
import { listOllamaModels } from "./brain/ollamaProvider.js";
import {
  loadVoiceConfig,
  saveVoiceConfig,
  setElevenLabsKey,
  setPicovoiceKey
} from "./voice/config.js";
import { startWakeWordListener, type WakeWordHandle } from "./voice/wake.js";
import { speak } from "./voice/tts.js";
import { resetPersonaToDefaults } from "./persona/reset.js";
import { loadPersonaConfig, savePersonaConfig } from "./persona/config.js";
import { startHeartbeatScheduler, stopHeartbeatScheduler } from "./persona/heartbeat.js";
import { startDeadlineNotifier, stopDeadlineNotifier } from "./persona/deadlines.js";
import { defaultProjectsRoot } from "./projects/paths.js";
import { defaultSkillsRoot } from "./skills/paths.js";
import { listSkillSummaries, verifySkillNow } from "./skills/tools.js";
import { listBuiltInCapabilities } from "./skills/builtins.js";
import { buildHostCapabilityDispatch, isCapabilityDeclaredForRun } from "./compute/hostCapabilities.js";
import { mkdir } from "node:fs/promises";

// Works around a well-known Electron/Chromium bug where the window paints
// solid black on some setups (VMs, remote/virtual displays, GPU-switching
// laptops) because the compositor never hands the painted frame to the
// window surface. Must be called before `app` is ready. Safe default for
// a small UI app like this one — we don't need GPU-accelerated rendering.
app.disableHardwareAcceleration();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/main/index.js -> app root is two levels up.
const APP_SOURCE_ROOT = path.resolve(__dirname, "..", "..");
const RESOURCES_DIR = path.resolve(__dirname, "..", "..", "resources");
const VOICE_TOGGLE_HOTKEY = "CommandOrControl+Shift+Space";

const workspaceRoot = defaultWorkspaceRoot(app.getPath("userData"));
const auditFilePath = defaultAuditFilePath(app.getPath("userData"));

let mainWindow: BrowserWindow | null = null;
let session: AgentSession | null = null;
let wakeHandle: WakeWordHandle | null = null;

// Bridge for the run_python tool: a tool call happens here in main, but
// actually executes in the renderer's sandboxed Pyodide worker (see
// src/renderer/python/pyodideWorker.ts). Main sends a request event and
// waits on this map; the renderer's reply resolves the matching entry.
const pendingPythonRequests = new Map<string, (result: PythonRunResult) => void>();
// pythonRuntime.ts's own 20s run timer now pauses while a host capability
// call is in flight (file I/O latency shouldn't eat into a skill's actual
// CPU budget) — so a run with several host calls can legitimately take
// longer than 20s wall-clock. This ceiling has to cover that: run timeout
// + pythonRuntime.ts's MAX_HOST_CALL_BUDGET_MS cumulative host-call
// allowance + a buffer, kept in sync by hand since main and the renderer
// can't literally import each other's constants across the Electron
// process boundary.
const PYTHON_BRIDGE_TIMEOUT_MS = 85_000;
// Built once — buildHostCapabilityDispatch() just wraps buildProjectsToolset
// (see hostCapabilities.ts), it has no per-turn or per-session state.
const hostCapabilityDispatch = buildHostCapabilityDispatch();

function runPythonInRenderer(code: string, args?: Record<string, unknown>, capabilities?: string[]): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    if (!mainWindow) {
      resolve({ stdout: "", result: null, error: "No window to run Python in." });
      return;
    }
    const id = crypto.randomUUID();
    pendingPythonRequests.set(id, resolve);
    mainWindow.webContents.send(IPC.pythonRunRequest, { id, code, args, capabilities });
    setTimeout(() => {
      if (!pendingPythonRequests.delete(id)) return; // already resolved by the real reply
      resolve({ stdout: "", result: null, error: "No response from the app window (was it closed or reloaded?)." });
    }, PYTHON_BRIDGE_TIMEOUT_MS);
  });
}

// Same request/reply-over-IPC shape as the Python bridge above, for the
// semantic_search_project_files tool: main owns file I/O (it already reads
// Projects files elsewhere), the renderer owns the embedding model that
// actually ranks the corpus (see src/renderer/search/projectSearch.ts).
const pendingSemanticSearchRequests = new Map<string, (hits: SemanticSearchHit[]) => void>();
const SEMANTIC_SEARCH_TIMEOUT_MS = 45_000; // first use downloads a small embedding model

function runSemanticSearchInRenderer(
  query: string,
  corpus: ProjectFileCorpusEntry[],
  topK: number
): Promise<SemanticSearchHit[]> {
  return new Promise((resolve) => {
    if (!mainWindow) {
      resolve([]);
      return;
    }
    const id = crypto.randomUUID();
    pendingSemanticSearchRequests.set(id, resolve);
    mainWindow.webContents.send(IPC.semanticSearchRequest, { id, query, topK, corpus });
    setTimeout(() => {
      if (!pendingSemanticSearchRequests.delete(id)) return; // already resolved by the real reply
      resolve([]);
    }, SEMANTIC_SEARCH_TIMEOUT_MS);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    title: "Mimir",
    show: false,
    backgroundColor: "#0b0c10",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's sandbox restricts ESM preload scripts on some platforms;
      // the preload here exposes nothing but the narrow `api` bridge above,
      // so the reduced isolation is an acceptable, documented trade-off.
      sandbox: false
    }
  });

  // Listeners must be attached BEFORE load*() — otherwise a preload/load
  // failure that happens during the load is missed entirely, since load*()
  // doesn't resolve until the page finishes loading.
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    void reportHealthy();
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[mimir] preload script failed at ${preloadPath}:`, error);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[mimir] renderer failed to load: ${code} ${description}`);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[mimir] renderer process gone:", details);
  });

  const devServerUrl = process.env.MIMIR_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  session = new AgentSession({
    win: mainWindow,
    workspaceRoot,
    auditFilePath,
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    runPython: runPythonInRenderer,
    resetPython: () => mainWindow?.webContents.send(IPC.pythonRunRequest, { reset: true }),
    semanticSearch: runSemanticSearchInRenderer
  });

  const voiceConfig = await loadVoiceConfig();
  if (voiceConfig.wakeWordEnabled) {
    wakeHandle = await startWakeWordListener(RESOURCES_DIR, () => {
      mainWindow?.webContents.send(IPC.voiceWakeTriggered);
    });
  }
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC.chatSend, (_event, text: string, attachments?: Attachment[]) => {
    void session?.send(text, attachments);
  });
  ipcMain.on(IPC.chatStop, () => {
    session?.stop();
  });

  ipcMain.handle(IPC.chatSpeak, async (_event, text: string): Promise<void> => {
    const cfg = await loadVoiceConfig();

    mainWindow?.webContents.send(IPC.faceState, "speaking");
    try {
      // Sentence-level renderer streaming gets audio underway early, while
      // playback stays in the main process. This avoids Chromium Web Audio
      // autoplay/suspension failures that could make ElevenLabs silent.
      await speak(text, {
        provider: cfg.ttsProvider,
        voiceId: cfg.elevenLabsVoiceId,
        systemVoice: cfg.systemVoice
      });
    } catch (err) {
      console.warn("[mimir] TTS failed:", err instanceof Error ? err.message : err);
    } finally {
      mainWindow?.webContents.send(IPC.faceState, "idle");
    }
  });

  ipcMain.on(IPC.editApprove, (_event, pendingId: string) => {
    session?.resolveApproval(pendingId, "approved");
  });
  ipcMain.on(IPC.editReject, (_event, pendingId: string) => {
    session?.resolveApproval(pendingId, "rejected");
  });

  ipcMain.handle(IPC.brainGetConfig, (): Promise<BrainConfig> => loadBrainConfig());
  ipcMain.handle(
    IPC.brainSetConfig,
    (_event, patch: Partial<Omit<BrainConfig, "hasApiKey">>): Promise<BrainConfig> => saveBrainConfig(patch)
  );
  ipcMain.handle(
    IPC.brainSetApiKey,
    async (_event, provider: BrainProviderKind, key: string): Promise<void> => {
      await setBrainApiKey(provider, key);
    }
  );
  ipcMain.handle(IPC.brainListOllamaModels, (_event, baseUrl?: string): Promise<string[]> =>
    listOllamaModels(baseUrl || undefined)
  );

  ipcMain.handle(IPC.voiceGetConfig, (): Promise<VoiceConfig> => loadVoiceConfig());
  ipcMain.handle(
    IPC.voiceSetConfig,
    async (
      _event,
      patch: Partial<
        Pick<VoiceConfig, "wakeWordEnabled" | "openMicEnabled" | "ttsProvider" | "elevenLabsVoiceId" | "systemVoice" | "wakeWordPath" | "followUpListenSeconds">
      >
    ): Promise<VoiceConfig> => {
      const next = await saveVoiceConfig(patch);
      // React to a live toggle of the wake word without requiring a restart.
      if (next.wakeWordEnabled && !wakeHandle) {
        wakeHandle = await startWakeWordListener(RESOURCES_DIR, () => {
          mainWindow?.webContents.send(IPC.voiceWakeTriggered);
        });
      } else if (!next.wakeWordEnabled && wakeHandle) {
        wakeHandle.stop();
        wakeHandle = null;
      }
      return next;
    }
  );
  ipcMain.handle(
    IPC.voiceSetApiKey,
    async (_event, kind: "picovoice" | "elevenlabs", key: string): Promise<void> => {
      if (kind === "picovoice") await setPicovoiceKey(key);
      else await setElevenLabsKey(key);
    }
  );

  ipcMain.on(IPC.voicePushToTalkStart, () => {
    // Avoid the wake word double-triggering while the user is manually talking.
    wakeHandle?.stop();
    wakeHandle = null;
  });
  ipcMain.on(IPC.voicePushToTalkStop, () => {
    void loadVoiceConfig().then(async (cfg) => {
      if (cfg.wakeWordEnabled && !wakeHandle) {
        wakeHandle = await startWakeWordListener(RESOURCES_DIR, () => {
          mainWindow?.webContents.send(IPC.voiceWakeTriggered);
        });
      }
    });
  });

  ipcMain.handle(IPC.auditList, () => session?.listAudit() ?? []);
  ipcMain.handle(IPC.auditRevert, async (_event, auditId: string) => {
    if (!session) return { ok: false, error: "No active session." };
    return session.revertAudit(auditId);
  });

  ipcMain.handle(IPC.personaReset, async () => {
    const result = await resetPersonaToDefaults(workspaceRoot, auditFilePath);
    if (result.status === "applied") return { ok: true };
    if (result.status === "rejected") return { ok: false, error: result.detail };
    return { ok: false, error: result.stepOutput };
  });

  ipcMain.handle(IPC.personaGetConfig, (): Promise<PersonaConfig> => loadPersonaConfig());
  ipcMain.handle(
    IPC.personaSetConfig,
    (_event, patch: Partial<PersonaConfig>): Promise<PersonaConfig> => savePersonaConfig(patch)
  );

  ipcMain.handle(IPC.projectsGetRoot, (): string => defaultProjectsRoot());
  ipcMain.handle(IPC.projectsOpenFolder, async (): Promise<{ ok: boolean; error?: string }> => {
    const root = defaultProjectsRoot();
    try {
      await mkdir(root, { recursive: true });
      const err = await shell.openPath(root);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC.skillsGetRoot, (): string => defaultSkillsRoot());
  ipcMain.handle(IPC.skillsList, (): Promise<SkillSummary[]> => listSkillSummaries(defaultSkillsRoot()));
  ipcMain.handle(
    IPC.skillsListBuiltIns,
    (): Promise<BuiltInCapability[]> => listBuiltInCapabilities(workspaceRoot, auditFilePath)
  );
  ipcMain.handle(
    IPC.skillsVerify,
    (_event, name: string): Promise<SkillSummary | null> => verifySkillNow(defaultSkillsRoot(), name, runPythonInRenderer)
  );
  ipcMain.handle(IPC.skillsOpenFolder, async (): Promise<{ ok: boolean; error?: string }> => {
    const root = defaultSkillsRoot();
    try {
      await mkdir(root, { recursive: true });
      const err = await shell.openPath(root);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // A running skill's Python called one of its declared host capabilities
  // (e.g. write_project_file) — see pythonRuntime.ts for the worker side of
  // this. Re-checked here against the fixed app-wide allowlist AND the
  // specific capabilities this run actually declared: the renderer already
  // only creates a `mimir.<name>` stub for a declared capability, but main
  // never trusts the renderer alone for anything else in this app either,
  // so this is the real enforcement point, not just the Python-level one.
  ipcMain.handle(
    IPC.pythonHostCall,
    async (
      _event,
      req: { capability: string; args: Record<string, unknown>; declaredCapabilities: string[] }
    ): Promise<{ content?: string; error?: string }> => {
      const { capability, args, declaredCapabilities } = req;
      if (!isCapabilityDeclaredForRun(capability, declaredCapabilities)) {
        return { error: `"${capability}" was not declared as a capability for this skill.` };
      }
      // Same visibility a top-level tool call gets (session.ts does this
      // identically at tool-start) — a skill's file write should look and
      // feel like any other tool call, not happen silently inside one.
      mainWindow?.webContents.send(IPC.faceState, "thinking");
      mainWindow?.webContents.send(IPC.chatStream, { type: "tool-start", name: capability });
      const result = await hostCapabilityDispatch(capability, args);
      mainWindow?.webContents.send(IPC.chatStream, { type: "tool-end", name: capability, isError: result.isError ?? false });
      return result.isError ? { error: result.content } : { content: result.content };
    }
  );

  ipcMain.on(IPC.pythonRunResponse, (_event, reply: { id: string } & PythonRunResult) => {
    const resolve = pendingPythonRequests.get(reply.id);
    if (resolve) {
      pendingPythonRequests.delete(reply.id);
      resolve(reply);
    }
  });

  ipcMain.on(IPC.semanticSearchResponse, (_event, reply: { id: string; hits: SemanticSearchHit[] }) => {
    const resolve = pendingSemanticSearchRequests.get(reply.id);
    if (resolve) {
      pendingSemanticSearchRequests.delete(reply.id);
      resolve(reply.hits);
    }
  });
}

function registerVoiceHotkey(): void {
  const registered = globalShortcut.register(VOICE_TOGGLE_HOTKEY, () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.voiceHotkeyTriggered);
  });

  if (!registered) {
    console.warn(`[mimir] Could not register voice hotkey ${VOICE_TOGGLE_HOTKEY}.`);
  }
}

app.whenReady().then(async () => {
  await bootstrapWorkspace(APP_SOURCE_ROOT, workspaceRoot);
  registerIpcHandlers();
  await createWindow();
  registerVoiceHotkey();
  startHeartbeatScheduler(workspaceRoot, auditFilePath);
  startDeadlineNotifier(workspaceRoot);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  wakeHandle?.stop();
  stopHeartbeatScheduler();
  stopDeadlineNotifier();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregister(VOICE_TOGGLE_HOTKEY);
});
