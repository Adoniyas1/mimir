import type {
  Attachment,
  BrainMessage,
  BrainProvider,
  ChatEvent,
  ChatOpts,
  ToolCall,
  ToolDef
} from "./Provider.js";

/**
 * Talks to any server implementing the OpenAI chat-completions wire format —
 * your own VPS running vLLM / text-generation-webui / llama.cpp's server,
 * or a hosted OpenAI-compatible endpoint. Base URL + optional key are the
 * only settings; no vendor SDK dependency.
 */
export class OpenAICompatibleProvider implements BrainProvider {
  readonly kind = "openai-compatible" as const;
  readonly model: string;
  private baseUrl: string;
  private apiKey: string | null;
  /** Best-effort: flips to false the first time the server rejects `tools`. */
  private toolsSupported = true;

  constructor(baseUrl: string, model: string, apiKey: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
  }

  supportsTools(): boolean {
    return this.toolsSupported;
  }

  supportsVision(): boolean {
    return false;
  }

  async *chat(
    messages: BrainMessage[],
    tools: ToolDef[],
    opts: ChatOpts
  ): AsyncGenerator<ChatEvent, void, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: true,
      max_tokens: opts.maxTokens ?? 8192,
      messages: toOpenAiMessages(opts.system, messages)
    };
    if (tools.length > 0 && this.toolsSupported) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      yield { type: "error", message: `Could not reach ${this.baseUrl}: ${errMsg(err)}` };
      yield { type: "done", stopReason: "error" };
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 400 && tools.length > 0 && /tool/i.test(text)) {
        // Server doesn't understand `tools` — remember that and let the
        // caller retry without them (agent loop treats this as no-tools).
        this.toolsSupported = false;
      }
      yield { type: "error", message: `HTTP ${res.status}: ${text.slice(0, 500)}` };
      yield { type: "done", stopReason: "error" };
      return;
    }

    if (!res.body) {
      yield { type: "error", message: "Empty response body" };
      yield { type: "done", stopReason: "error" };
      return;
    }

    const pendingCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | null = null;

    for await (const line of sseLines(res.body)) {
      if (line === "[DONE]") break;
      let json: OpenAiChunk;
      try {
        json = JSON.parse(line) as OpenAiChunk;
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: "text-delta", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const existing = pendingCalls.get(idx) ?? { id: tc.id ?? `call-${idx}`, name: "", args: "" };
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        if (tc.id) existing.id = tc.id;
        pendingCalls.set(idx, existing);
      }
    }

    for (const call of pendingCalls.values()) {
      if (!call.name) continue;
      const parsed: ToolCall = { id: call.id, name: call.name, input: safeJson(call.args) };
      yield { type: "tool-call", call: parsed };
    }

    yield {
      type: "done",
      stopReason: finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn"
    };
  }
}

interface OpenAiChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

function toOpenAiMessages(system: string, messages: BrainMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) }
        }))
      });
    } else if (m.attachments?.length) {
      out.push({ role: "user", content: toOpenAiContentParts(m.content, m.attachments) });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}

/**
 * Standard OpenAI-vision content-part shape: text parts plus
 * `image_url` parts carrying a data URI. Text attachments are always
 * inlined as extra text parts (works with or without vision support).
 * PDFs get a plain-text note — see the Attachment doc comment in
 * brain/Provider.ts for why extraction is out of scope here.
 */
function toOpenAiContentParts(text: string, attachments: Attachment[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ type: "text", text });
  for (const att of attachments) {
    if (att.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: `data:${att.mimeType};base64,${att.data}` } });
    } else if (att.kind === "document") {
      parts.push({ type: "text", text: `[Attached PDF "${att.name}" — this provider can't read PDFs directly.]` });
    } else {
      parts.push({ type: "text", text: `--- attached: ${att.name} ---\n${att.data}` });
    }
  }
  return parts;
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

function safeJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _unparsed: text };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
