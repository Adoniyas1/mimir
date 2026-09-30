import type { PythonRunResult } from "../../shared/types.js";

const RUN_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;
/** Per-call ceiling on one host capability round-trip (main dispatches it
 * through a real, already-fast confined handler — this generously covers
 * file I/O without being so long a genuinely hung call stalls the run for
 * an unreasonable time). */
const HOST_CALL_TIMEOUT_MS = 15_000;
/** A run's own RUN_TIMEOUT_MS excludes time spent waiting on host calls
 * (see pauseTimer/resumeTimer below) — otherwise a skill doing real file
 * I/O would be timed out for latency that isn't its own CPU time. But
 * "excluded from the run timer" can't mean "unbounded": a skill making
 * host call after host call forever still has to end. This is that
 * separate, cumulative ceiling — kept in sync by hand with main/index.ts's
 * PYTHON_BRIDGE_TIMEOUT_MS, which has to cover RUN_TIMEOUT_MS plus this. */
const MAX_HOST_CALL_BUDGET_MS = 60_000;

interface WorkerReply extends PythonRunResult {
  type: "reply";
  id: string;
}

interface HostCallMessage {
  type: "host-call";
  callId: string;
  capability: string;
  args: Record<string, unknown>;
}

type WorkerMessage = WorkerReply | HostCallMessage;

interface RunState {
  resolve: (r: PythonRunResult) => void;
  /** This run's declared host capabilities — forwarded with every host-call
   * relay so main can check the call against what this specific skill
   * actually asked for, not just the app-wide fixed allowlist. */
  capabilities: string[];
  /** Remaining budget for this run's own execution, and when the
   * currently-armed timer segment started — together these let a host call
   * pause the clock and resume it with the correct remainder rather than
   * either restarting a full RUN_TIMEOUT_MS or leaking the paused time. */
  remainingMs: number;
  segmentStartedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  cumulativeHostCallMs: number;
}

/**
 * Owns one lazily-created, persistent Pyodide worker — see pyodideWorker.ts
 * for the actual sandbox. Python globals persist across calls within a
 * session (a REPL/notebook model: define a variable once, reuse it later)
 * until the app restarts or reset() is called. A run that takes too long
 * gets the whole worker killed via terminate() — there's no graceful
 * "cancel" for a hung WASM interpreter, so this is the real backstop.
 */
class PythonRuntime {
  private worker: Worker | null = null;
  private runs = new Map<string, RunState>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./pyodideWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (data.type === "host-call") {
        void this.handleHostCall(worker, data);
        return;
      }
      const state = this.runs.get(data.id);
      if (state) {
        this.runs.delete(data.id);
        if (state.timer) clearTimeout(state.timer);
        state.resolve({ stdout: data.stdout, result: data.result, error: data.error, images: data.images });
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      // The worker crashed outright (not a Python exception, an actual
      // fatal JS/WASM error) — fail every call currently waiting on it and
      // drop the worker so the next run() starts a fresh one.
      for (const state of this.runs.values()) {
        if (state.timer) clearTimeout(state.timer);
        state.resolve({ stdout: "", result: null, error: `Python sandbox crashed: ${event.message}` });
      }
      this.runs.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  /** Relays one host-call request from the worker to main (over IPC) and
   * the reply back to the worker. Pauses the originating run's timeout for
   * exactly the round-trip's duration — see the RunState doc comment. */
  private async handleHostCall(worker: Worker, msg: HostCallMessage): Promise<void> {
    const state = this.currentRun();
    if (state?.timer) {
      clearTimeout(state.timer);
      state.remainingMs = Math.max(0, state.remainingMs - (Date.now() - state.segmentStartedAt));
      state.timer = null;
    }

    const startedAt = Date.now();
    let reply: { content?: string; error?: string };
    try {
      reply = await withTimeout(
        window.mimir.python.hostCall(msg.capability, msg.args, state?.capabilities ?? []),
        HOST_CALL_TIMEOUT_MS,
        `Host capability "${msg.capability}" timed out after ${HOST_CALL_TIMEOUT_MS / 1000}s.`
      );
    } catch (err) {
      reply = { error: err instanceof Error ? err.message : String(err) };
    }

    worker.postMessage({ type: "host-result", callId: msg.callId, ...reply });

    if (!state) return;
    state.cumulativeHostCallMs += Date.now() - startedAt;
    if (state.cumulativeHostCallMs > MAX_HOST_CALL_BUDGET_MS) {
      // Not one slow call — a run that keeps making them, forever. The
      // per-call timeout above can't catch this on its own since each
      // individual call may complete quickly.
      const id = this.idForState(state);
      if (id) this.runs.delete(id);
      state.resolve({
        stdout: "",
        result: null,
        error: `Exceeded the ${MAX_HOST_CALL_BUDGET_MS / 1000}s total host-call budget for one run.`
      });
      worker.terminate();
      this.worker = null;
      return;
    }
    state.segmentStartedAt = Date.now();
    const id = this.idForState(state);
    if (id) state.timer = setTimeout(() => this.timeoutRun(worker, id), state.remainingMs);
  }

  // A host call arrives tagged only by its own callId, not the outer run's
  // id — in practice exactly one run is ever in flight at a time (Mimir's
  // agent loop awaits each tool call before starting the next), so "the
  // one active run" is unambiguous. This is a real lookup over the live
  // run map rather than a cached reference, so if that assumption ever
  // stops holding (a genuinely concurrent run added later), this starts
  // returning undefined/an arbitrary run instead of silently misattributing
  // a call to the wrong one — a visible bug to fix, not a quiet one.
  private currentRun(): RunState | undefined {
    const [only] = this.runs.values();
    return only;
  }

  private idForState(state: RunState): string | undefined {
    for (const [id, s] of this.runs) if (s === state) return id;
    return undefined;
  }

  private timeoutRun(worker: Worker, id: string): void {
    const state = this.runs.get(id);
    if (!state) return;
    this.runs.delete(id);
    state.resolve({
      stdout: "",
      result: null,
      error: `Timed out after ${RUN_TIMEOUT_MS / 1000}s of execution — the sandbox was reset.`
    });
    worker.terminate();
    this.worker = null;
  }

  async run(code: string, args?: Record<string, unknown>, capabilities: string[] = []): Promise<PythonRunResult> {
    const worker = this.ensureWorker();
    const id = crypto.randomUUID();

    const result = await new Promise<PythonRunResult>((resolve) => {
      const state: RunState = {
        resolve,
        capabilities,
        remainingMs: RUN_TIMEOUT_MS,
        segmentStartedAt: Date.now(),
        timer: null,
        cumulativeHostCallMs: 0
      };
      state.timer = setTimeout(() => this.timeoutRun(worker, id), state.remainingMs);
      this.runs.set(id, state);
      worker.postMessage({ type: "run", id, code, args, capabilities });
    });

    return {
      stdout: truncate(result.stdout),
      result: result.result ? truncate(result.result) : result.result,
      error: result.error ? truncate(result.error) : result.error,
      images: result.images
    };
  }

  reset(): void {
    if (!this.worker) return;
    // Pyodide can only be loaded once per JS global scope — a second
    // loadPyodide() call in the same worker throws ("Pyodide is already
    // loading"), it doesn't give you a clean interpreter. So "reset" can't
    // be a message the worker handles in place; it has to be a fresh
    // worker, same mechanism the timeout path already uses.
    for (const state of this.runs.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.resolve({ stdout: "", result: null, error: "Python sandbox reset." });
    }
    this.runs.clear();
    this.worker.terminate();
    this.worker = null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[...truncated...]` : text;
}

export const pythonRuntime = new PythonRuntime();
