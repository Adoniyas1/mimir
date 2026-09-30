/**
 * Runs entirely inside a dedicated Web Worker — its own global scope, no
 * access to window.mimir, no Node integration, nothing but postMessage in
 * and out. Pyodide (CPython compiled to WASM) loads lazily from jsDelivr
 * (already allowlisted in the CSP for transformers.js) on first use, not
 * at app startup.
 *
 * SECURITY BOUNDARY, READ BEFORE EDITING: this file must never call
 * `pyodide.FS.mount(...)` or anything that exposes the real filesystem to
 * the sandbox. Pyodide's default FS is an in-memory MEMFS — the absence of
 * a mount call *is* the enforcement, there's no separate check to bypass.
 * Network is bounded by this page's CSP connect-src, which the worker
 * inherits since it's a same-origin module worker. Don't add new host
 * permissions here without updating the CSP deliberately and reviewing why.
 *
 * The one deliberate hole in "no host access" is the host-call protocol
 * below: a skill can call back into a small, named, per-run-declared set of
 * app actions (e.g. write_project_file) — never a raw filesystem or shell,
 * always through the exact same confined handlers a real tool call uses
 * (see compute/hostCapabilities.ts, enforced in main, not here). This file
 * only ever offers Python a `mimir.<name>(...)` awaitable for a name it was
 * explicitly told about for this run; it can't invent a new one.
 */

const PYODIDE_VERSION = "v314.0.4";
const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

interface RunRequest {
  type: "run";
  id: string;
  code: string;
  /** Bound as a plain `args` dict global before the code runs — how a
   * parameterized skill (see skills/dynamicTools.ts) receives its call
   * arguments. Set via pyodide.globals.set(), never string-interpolated
   * into the code itself, so there is no quoting/injection surface. */
  args?: Record<string, unknown>;
  /** This run's declared host capabilities (from the skill's manifest) —
   * the exhaustive list of `mimir.<name>` bindings created before the
   * code runs. Nothing outside this list is ever reachable. */
  capabilities?: string[];
}

interface RunReply {
  type: "reply";
  id: string;
  stdout: string;
  result: string | null;
  error: string | null;
  images?: string[];
}

/** Outgoing: "Python called a host capability, please dispatch it and
 * reply." Handled by pythonRuntime.ts, which relays it over IPC to main
 * and posts a matching HostResultMessage back once main replies. */
interface HostCallMessage {
  type: "host-call";
  callId: string;
  capability: string;
  args: Record<string, unknown>;
}

/** Incoming: pythonRuntime.ts's reply to a HostCallMessage, correlated by
 * callId. Resolves (content) or rejects (error) the awaitable that's
 * blocking the Python `await mimir.<name>(...)` call. */
interface HostResultMessage {
  type: "host-result";
  callId: string;
  content?: string;
  error?: string;
}

const MAX_PLOT_IMAGES = 4;
const MAX_TOTAL_IMAGE_CHARS = 6_000_000; // base64 chars, generous headroom under the ~20s run budget

/** Grabs any matplotlib figures left open after a run and returns them as
 * base64 PNGs, then closes them. Best-effort: returns [] on any failure
 * (including "matplotlib was never imported") rather than touching the
 * real run's result/error. Run this with the Agg backend (see below) —
 * matplotlib's default interactive backends need a DOM canvas this worker
 * doesn't have. */
const CAPTURE_FIGURES_SNIPPET = `
import sys, base64, io, json as _mimir_json
_mimir_images = []
if 'matplotlib.pyplot' in sys.modules:
    import matplotlib.pyplot as _mimir_plt
    for _mimir_num in _mimir_plt.get_fignums()[:${MAX_PLOT_IMAGES}]:
        _mimir_buf = io.BytesIO()
        _mimir_plt.figure(_mimir_num).savefig(_mimir_buf, format="png", bbox_inches="tight", dpi=110)
        _mimir_images.append(base64.b64encode(_mimir_buf.getvalue()).decode("ascii"))
    _mimir_plt.close("all")
_mimir_json.dumps(_mimir_images)
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PyodideInterface = any;

let pyodidePromise: Promise<PyodideInterface> | null = null;

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_CDN_BASE}pyodide.mjs`);
      // No filesystem mounts, no extra permissions passed here — see the
      // file-level comment above. This is the whole sandbox, not a partial
      // one. (Pyodide's WASM heap has a build-time ceiling; the reliable,
      // verifiable limit this app enforces is the wall-clock timeout in
      // pythonRuntime.ts, which terminates the whole worker if execution
      // runs long — that's the actual backstop, not a runtime memory knob.)
      return loadPyodide({ indexURL: PYODIDE_CDN_BASE });
    })();
  }
  return pyodidePromise;
}

let hostCallCounter = 0;
const pendingHostCalls = new Map<string, { resolve: (content: string) => void; reject: (err: Error) => void }>();

/**
 * The JS function `_mimir_host_call` is bound to in Python (see
 * buildCapabilitySetupSnippet). Resolves with the capability's plain-text
 * result on success; rejects on failure — which Pyodide surfaces as a
 * normal raised Python exception when awaited, so a failed host call needs
 * no bespoke error-shape handling anywhere downstream, it flows through
 * the exact same catch block as any other Python error.
 */
function hostCall(capability: string, pyArgs: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const callId = `hc-${++hostCallCounter}`;
    pendingHostCalls.set(callId, { resolve, reject });
    // pyArgs arrives as a PyProxy-wrapped dict (Python kwargs collected
    // into a dict by the capability stub below) — convert it to a plain,
    // structured-cloneable JS object before postMessage, which can't carry
    // a PyProxy tied to the WASM heap across the worker boundary.
    const args = toPlainObject(pyArgs);
    const message: HostCallMessage = { type: "host-call", callId, capability, args };
    (self as unknown as Worker).postMessage(message);
  });
}

function toPlainObject(value: unknown): Record<string, unknown> {
  const maybeProxy = value as { toJs?: (opts: unknown) => unknown } | null | undefined;
  if (maybeProxy && typeof maybeProxy.toJs === "function") {
    return (maybeProxy.toJs({ dict_converter: Object.fromEntries }) as Record<string, unknown>) ?? {};
  }
  return (value as Record<string, unknown>) ?? {};
}

/** Python source defining `mimir.<name>(...)` for exactly the declared
 * capabilities, nothing else — run once before the user's own code, only
 * when there's at least one. Each binding forwards its kwargs to the JS
 * `_mimir_host_call` bridge and awaits the reply; capability names are
 * always drawn from the fixed, filtered list this worker was given (see
 * dynamicTools.ts / hostCapabilities.ts), never raw model/user text, so
 * splicing them into a Python list literal here carries no injection risk. */
function buildCapabilitySetupSnippet(capabilities: string[]): string {
  const names = capabilities.map((name) => JSON.stringify(name)).join(", ");
  return `
class _MimirCapabilities:
    pass

def _mimir_make_capability(_mimir_cap_name):
    async def _mimir_call(**kwargs):
        return await _mimir_host_call(_mimir_cap_name, kwargs)
    return _mimir_call

mimir = _MimirCapabilities()
for _mimir_cap_name in [${names}]:
    setattr(mimir, _mimir_cap_name, _mimir_make_capability(_mimir_cap_name))
`;
}

self.onmessage = async (event: MessageEvent<RunRequest | HostResultMessage>) => {
  const data = event.data;
  if (data.type === "host-result") {
    const pending = pendingHostCalls.get(data.callId);
    if (!pending) return; // already resolved, or a stale/duplicate reply — ignore rather than throw
    pendingHostCalls.delete(data.callId);
    if (data.error !== undefined) pending.reject(new Error(data.error));
    else pending.resolve(data.content ?? "");
    return;
  }

  // Resetting is handled by pythonRuntime.ts terminating this whole worker
  // and creating a fresh one — Pyodide can't be reloaded in place within
  // the same JS global scope (a second loadPyodide() call throws). This
  // worker only ever needs to handle a run request beyond this point.
  const { id, code, args, capabilities } = data;
  let stdout = "";
  try {
    const pyodide = await getPyodide();
    pyodide.setStdout({ batched: (msg: string) => (stdout += `${msg}\n`) });
    pyodide.setStderr({ batched: (msg: string) => (stdout += `${msg}\n`) });

    // Always bind `args` — even to an empty dict for a call with none — so
    // a skill can unconditionally read it rather than needing a
    // NameError-guarded fallback. Setting a global never touches the code
    // string itself, so there's no quoting/injection surface here.
    pyodide.globals.set("args", pyodide.toPy(args ?? {}));

    if (capabilities && capabilities.length > 0) {
      pyodide.globals.set("_mimir_host_call", hostCall);
      await pyodide.runPythonAsync(buildCapabilitySetupSnippet(capabilities));
    }

    await pyodide.loadPackagesFromImports(code);
    // matplotlib's default backends assume a DOM canvas this worker doesn't
    // have; force the headless Agg backend before the user's own import
    // runs. Only pay this cost when the code actually mentions matplotlib.
    if (/matplotlib/.test(code)) {
      await pyodide.runPythonAsync("import matplotlib\nmatplotlib.use('Agg')").catch(() => undefined);
    }

    const value = await pyodide.runPythonAsync(code);
    const result = value === undefined || value === null ? null : pyToDisplayString(value);
    const images = await captureFigures(pyodide);

    const reply: RunReply = { type: "reply", id, stdout, result, error: null, images };
    (self as unknown as Worker).postMessage(reply);
  } catch (err) {
    const reply: RunReply = { type: "reply", id, stdout, result: null, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(reply);
  }
};

async function captureFigures(pyodide: PyodideInterface): Promise<string[] | undefined> {
  try {
    const raw = await pyodide.runPythonAsync(CAPTURE_FIGURES_SNIPPET);
    const images = JSON.parse(String(raw)) as string[];
    if (!Array.isArray(images) || images.length === 0) return undefined;
    const kept: string[] = [];
    let total = 0;
    for (const img of images) {
      if (total + img.length > MAX_TOTAL_IMAGE_CHARS) break;
      kept.push(img);
      total += img.length;
    }
    return kept.length > 0 ? kept : undefined;
  } catch {
    // Best-effort — a capture failure should never fail the actual run.
    return undefined;
  }
}

function pyToDisplayString(value: unknown): string {
  // Simple Python values (numbers, strings, booleans) already come back as
  // native JS values via Pyodide's automatic conversion. Anything else
  // (numpy arrays, sympy expressions, ...) is a PyProxy whose own
  // toString() calls into Python's str()/repr() machinery — good enough
  // for display without a bespoke conversion path here.
  try {
    return String(value);
  } catch (err) {
    return `<unprintable result: ${err instanceof Error ? err.message : String(err)}>`;
  }
}
