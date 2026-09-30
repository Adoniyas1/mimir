import type {
  Attachment,
  BrainMessage,
  BrainProvider,
  ChatEvent,
  ChatOpts,
  ToolCall,
  ToolDef
} from "./Provider.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_BASE_URL = DEFAULT_OLLAMA_BASE_URL;

/** Queries Ollama's own `/api/tags` endpoint for models actually pulled on
 * this machine, so QuickControls can offer a real list instead of a blind
 * text field. Returns [] (never throws) if Ollama isn't running or isn't
 * reachable at this URL — that's a normal, expected state, not an error. */
export async function listOllamaModels(baseUrl: string = DEFAULT_OLLAMA_BASE_URL): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .sort();
  } catch {
    return [];
  }
}

// Heuristic only — Ollama has no capability-discovery endpoint, so we start
// optimistic for models known to support function calling and flip to false
// the first time a tool-bearing request errors out.
const LIKELY_TOOL_CAPABLE = /llama3\.[123]|qwen2(\.5)?|mistral-nemo|firefunction|command-r|mixtral/i;

export class OllamaProvider implements BrainProvider {
  readonly kind = "ollama" as const;
  readonly model: string;
  private baseUrl: string;
  private toolsSupported: boolean;

  constructor(model: string, baseUrl: string = DEFAULT_BASE_URL) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.toolsSupported = LIKELY_TOOL_CAPABLE.test(model);
  }

  supportsTools(): boolean {
    return this.toolsSupported;
  }

  supportsVision(): boolean {
    return /llava|vision|bakllava/i.test(this.model);
  }

  async *chat(
    messages: BrainMessage[],
    tools: ToolDef[],
    opts: ChatOpts
  ): AsyncGenerator<ChatEvent, void, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      messages: toOllamaMessages(opts.system, messages)
    };
    if (tools.length > 0 && this.toolsSupported) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        type: "error",
        message: `Could not reach Ollama at ${this.baseUrl} (is \`ollama serve\` running?): ${msg}`
      };
      yield { type: "done", stopReason: "error" };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 400 && tools.length > 0) this.toolsSupported = false;
      yield { type: "error", message: `Ollama HTTP ${res.status}: ${text.slice(0, 500)}` };
      yield { type: "done", stopReason: "error" };
      return;
    }
    if (!res.body) {
      yield { type: "error", message: "Empty response body from Ollama" };
      yield { type: "done", stopReason: "error" };
      return;
    }

    let sawToolCall = false;
    const toolNames = new Set(tools.map((t) => t.name));
    // Small models sometimes have "native" tool support in the sense that
    // Ollama accepts the `tools` param, but still occasionally write a
    // tool-call-shaped JSON object into plain content instead of the
    // structured tool_calls field — live-observed with llama3.2:3b. Buffer
    // content and recover those before they ever reach the visible chat;
    // see leakedToolCall.ts.
    let contentBuffer = "";
    let scanning = false;

    for await (const line of ndjsonLines(res.body)) {
      let chunk: OllamaChunk;
      try {
        chunk = JSON.parse(line) as OllamaChunk;
      } catch {
        continue;
      }

      if (chunk.message?.content) {
        contentBuffer += chunk.message.content;
        for (;;) {
          if (!scanning) {
            const braceIndex = contentBuffer.indexOf("{");
            if (braceIndex === -1) {
              // A buffer left holding nothing but whitespace/stray closing
              // braces is virtually always an orphaned artifact of a
              // malformed tool-call blob (e.g. a doubled closing brace),
              // not real content — legitimate prose never looks like this.
              if (contentBuffer && !/^[\s}]*$/.test(contentBuffer)) {
                yield { type: "text-delta", text: contentBuffer };
              }
              contentBuffer = "";
              break;
            }
            if (braceIndex > 0) {
              yield { type: "text-delta", text: contentBuffer.slice(0, braceIndex) };
              contentBuffer = contentBuffer.slice(braceIndex);
            }
            scanning = true;
          }

          const found = findBalancedJsonObject(contentBuffer);
          if (!found) {
            if (contentBuffer.length > MAX_SCAN_BUFFER_CHARS) {
              // Never resolved into a balanced object — give up waiting
              // rather than stall streaming indefinitely.
              for (const ev of resolveUnresolvedBuffer(contentBuffer, toolNames)) {
                if (ev.type === "tool-call") sawToolCall = true;
                yield ev;
              }
              contentBuffer = "";
              scanning = false;
            }
            break; // wait for more chunks
          }

          // Strict parse first; small models sometimes produce a tool-call
          // attempt that's syntactically broken (a stray quote, a missing
          // wrapper key) but still unambiguously an attempt — a lenient
          // field scan recovers what it can rather than showing the user
          // raw broken JSON. Whatever it can't recover is left for the
          // tool's own input validation to reject with a clear error the
          // model can react to, same as any other bad tool call.
          const leaked =
            tryExtractLeakedToolCall(found.json, toolNames) ?? lenientExtractLeakedToolCall(found.json, toolNames);
          if (leaked) {
            sawToolCall = true;
            yield {
              type: "tool-call",
              call: {
                id: `ollama-leak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: leaked.name,
                input: leaked.input
              }
            };
          } else {
            // Doesn't even look like an attempted tool call — legitimate
            // content, show it unaltered rather than silently dropping it.
            yield { type: "text-delta", text: found.json };
          }
          contentBuffer = contentBuffer.slice(found.endIndex);
          scanning = false;
        }
      }

      for (const tc of chunk.message?.tool_calls ?? []) {
        sawToolCall = true;
        const call: ToolCall = {
          id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function.name,
          input: tc.function.arguments ?? {}
        };
        yield { type: "tool-call", call };
      }
      if (chunk.done) break;
    }

    // The stream ended mid-buffer (e.g. cut off before a '{' ever closed,
    // often because a stray/missing quote corrupted the rest of the
    // brace-matching) — try a lenient recovery before giving up and
    // showing raw text.
    if (contentBuffer) {
      for (const ev of resolveUnresolvedBuffer(contentBuffer, toolNames)) {
        if (ev.type === "tool-call") sawToolCall = true;
        yield ev;
      }
    }

    yield { type: "done", stopReason: sawToolCall ? "tool_use" : "end_turn" };
  }
}

const MAX_SCAN_BUFFER_CHARS = 20_000;

/** Last resort for a buffer that never resolved into a cleanly balanced
 * `{...}` object — a single stray or missing quote early in a malformed
 * blob corrupts the rest of findBalancedJsonObject's quote-tracking, so
 * brace-matching alone can't always find the end. lenientExtractLeakedToolCall
 * doesn't need a clean boundary — its regex scan works fine against the
 * raw, unresolved buffer directly — so try that before giving up and
 * showing the user broken JSON. */
function resolveUnresolvedBuffer(buffer: string, toolNames: ReadonlySet<string>): ChatEvent[] {
  const leaked = lenientExtractLeakedToolCall(buffer, toolNames);
  if (leaked) {
    return [
      {
        type: "tool-call",
        call: {
          id: `ollama-leak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: leaked.name,
          input: leaked.input
        }
      }
    ];
  }
  return buffer ? [{ type: "text-delta", text: buffer }] : [];
}

/** Scans `text` (which must start with '{') for the first balanced {...}
 * object, respecting quoted strings so braces inside a JSON string value
 * (e.g. Python code containing dict literals) don't throw off the count.
 * Returns null if not yet balanced — caller should accumulate more text
 * and retry. */
function findBalancedJsonObject(text: string): { json: string; endIndex: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(0, i + 1), endIndex: i + 1 };
    }
  }
  return null;
}

/** Only treats a parsed object as a real leaked tool call if its "name"
 * matches one actually offered this turn — otherwise it's just JSON the
 * model legitimately wrote (an example, a data structure, ...), not a
 * misrouted tool call. */
function tryExtractLeakedToolCall(
  json: string,
  toolNames: ReadonlySet<string>
): { name: string; input: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || !toolNames.has(obj.name)) return null;
  const argsKey = ["input", "parameters", "arguments"].find(
    (k) => obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])
  );
  const input = argsKey ? (obj[argsKey as string] as Record<string, unknown>) : {};
  return { name: obj.name, input };
}

/** Fallback for a blob that isn't valid JSON but still unambiguously opens
 * like a tool call (`{"name": "<a real tool>"`). Scans for `"key":"value"`
 * string pairs anywhere in the text rather than requiring well-formed
 * structure — good enough for the tool's own input validation to work
 * with, or to reject with a clear, actionable error. The first "name"
 * match is the tool selector, not a field, and is skipped; a later "name"
 * key (e.g. a skill's own name) is kept. */
function lenientExtractLeakedToolCall(
  text: string,
  toolNames: ReadonlySet<string>
): { name: string; input: Record<string, unknown> } | null {
  const nameMatch = text.match(/^\{\s*"name"\s*:\s*"([a-zA-Z0-9_-]+)"/);
  const toolName = nameMatch?.[1];
  if (!toolName || !toolNames.has(toolName)) return null;

  const input: Record<string, unknown> = {};
  const fieldRe = /"([a-zA-Z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let sawSelectorName = false;
  let match: RegExpExecArray | null;
  while ((match = fieldRe.exec(text))) {
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (key === "name" && !sawSelectorName) {
      sawSelectorName = true;
      continue;
    }
    if (key in input) continue;
    input[key] = rawValue.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return { name: toolName, input };
}

interface OllamaChunk {
  message?: {
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments?: Record<string, unknown> } }>;
  };
  done?: boolean;
}

function toOllamaMessages(system: string, messages: BrainMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.input } }))
      });
    } else if (m.attachments?.length) {
      out.push(toOllamaUserMessage(m.content, m.attachments));
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

/**
 * Ollama's vision models take images as a plain base64 array alongside the
 * text (no data-URI prefix). Text attachments are always inlined — that
 * path needs no vision support and works on every model. PDFs get an
 * explicit "can't read this" note rather than a half-working extraction —
 * see the Attachment type's doc comment in brain/Provider.ts.
 */
function toOllamaUserMessage(text: string, attachments: Attachment[]): Record<string, unknown> {
  const images: string[] = [];
  const textParts = [text];
  for (const att of attachments) {
    if (att.kind === "image") images.push(att.data);
    else if (att.kind === "document") textParts.push(`[Attached PDF "${att.name}" — this local model can't read PDFs directly.]`);
    else textParts.push(`--- attached: ${att.name} ---\n${att.data}`);
  }
  return { role: "user", content: textParts.filter(Boolean).join("\n\n"), ...(images.length ? { images } : {}) };
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}
