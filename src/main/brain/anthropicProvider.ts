import Anthropic from "@anthropic-ai/sdk";
import type {
  Attachment,
  BrainMessage,
  BrainProvider,
  ChatEvent,
  ChatOpts,
  ToolCall,
  ToolDef
} from "./Provider.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const DEFAULT_MODEL = "claude-opus-5";

export class AnthropicProvider implements BrainProvider {
  readonly kind = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.model = model;
    // Constructing the client does no I/O — safe to do eagerly.
    this.client = new Anthropic({ apiKey });
  }

  supportsTools(): boolean {
    return true;
  }

  supportsVision(): boolean {
    return true;
  }

  async *chat(
    messages: BrainMessage[],
    tools: ToolDef[],
    opts: ChatOpts
  ): AsyncGenerator<ChatEvent, void, unknown> {
    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools: Anthropic.ToolUnion[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema
    }));
    if (opts.webSearchEnabled) {
      // Server-side tool — Claude executes it directly, no tool_result round-trip
      // needed on our side. content_block_start for this type doesn't match our
      // "tool_use" handling below, so its blocks pass through the stream loop
      // as inert (already reflected in the final answer text).
      anthropicTools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
    }

    // The stable system prompt and tool definitions are the reusable request
    // prefix. Mark the final block in each so Anthropic can cache everything
    // before it across turns.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } }
    ];
    const lastTool = anthropicTools.at(-1);
    if (lastTool) lastTool.cache_control = { type: "ephemeral" };

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: opts.maxTokens ?? 8192,
        system,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort ?? "high" }
      });

      // Track tool_use blocks as they stream in (name arrives at block-start,
      // input JSON arrives incrementally via input_json_delta).
      const pendingToolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();

      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          pendingToolBlocks.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: ""
          });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text-delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const pending = pendingToolBlocks.get(event.index);
            if (pending) pending.inputJson += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const pending = pendingToolBlocks.get(event.index);
          if (pending) {
            const call: ToolCall = {
              id: pending.id,
              name: pending.name,
              input: safeParseJson(pending.inputJson)
            };
            yield { type: "tool-call", call };
          }
        }
      }

      const final = await stream.finalMessage();
      const stopReason =
        final.stop_reason === "tool_use"
          ? "tool_use"
          : final.stop_reason === "max_tokens"
            ? "max_tokens"
            : "end_turn";
      yield { type: "done", stopReason };
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done", stopReason: "error" };
    }
  }
}

function safeParseJson(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { _unparsed: json };
  }
}

/**
 * Images become native `image` blocks and PDFs become native `document`
 * blocks — Claude reads both directly, no client-side extraction. Anything
 * else ("text" kind — code/markdown/plain files) is just inlined as an
 * extra text block; that path works for every attachment type as a
 * fallback and needs no vision support at all.
 */
function toUserContentBlocks(text: string, attachments: Attachment[]): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];
  if (text) content.push({ type: "text", text });
  for (const att of attachments) {
    if (att.kind === "image" && SUPPORTED_IMAGE_TYPES.has(att.mimeType)) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: att.data }
      });
    } else if (att.kind === "document") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: att.data }
      });
    } else {
      content.push({ type: "text", text: `--- attached: ${att.name} ---\n${att.data}` });
    }
  }
  return content;
}

function toAnthropicMessages(messages: BrainMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // system goes on opts.system, not messages
    if (m.role === "user") {
      out.push({ role: "user", content: m.attachments?.length ? toUserContentBlocks(m.content, m.attachments) : m.content });
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
            is_error: m.isError ?? false
          }
        ]
      });
    }
  }
  return out;
}
