/**
 * Wraps a text-only provider (a small local model with no native function
 * calling) so the rest of the app can still talk to it through the normal
 * tool-calling ChatEvent stream.
 *
 * The model is instructed, via the system prompt, to emit a line of the
 * form `TOOL_CALL: {"name": "...", "input": {...}}` when it wants to call a
 * tool. We scan the streamed text for that pattern and translate matches
 * into ordinary `tool-call` events — the agent loop (src/main/agent/loop.ts)
 * cannot tell the difference between this and native tool use.
 *
 * This is a best-effort fallback, not a guarantee: weak models sometimes
 * fail to follow the convention. That's an acceptable ceiling for "skills"
 * but is exactly why self-editing (src/main/self-edit) is gated behind
 * supportsTools() and disabled for shimmed providers by default.
 */

import type { BrainMessage, BrainProvider, ChatEvent, ChatOpts, ToolDef } from "./Provider.js";

const TOOL_CALL_RE = /TOOL_CALL:\s*(\{[\s\S]*?\})\s*(?:\n|$)/;

export function withReactShim(inner: BrainProvider): BrainProvider {
  return {
    kind: inner.kind,
    model: inner.model,
    supportsTools: () => true,
    supportsVision: () => inner.supportsVision(),
    async *chat(
      messages: BrainMessage[],
      tools: ToolDef[],
      opts: ChatOpts
    ): AsyncGenerator<ChatEvent, void, unknown> {
      const shimSystem = buildShimSystemPrompt(opts.system, tools);
      let buffer = "";
      let emittedToolCall = false;
      let seq = 0;

      // Tools are described in the prompt, not passed structurally — the
      // wrapped provider may not understand a `tools` request parameter.
      for await (const ev of inner.chat(messages, [], { ...opts, system: shimSystem })) {
        if (ev.type === "text-delta") {
          buffer += ev.text;
          const match = buffer.match(TOOL_CALL_RE);
          if (match && match.index !== undefined) {
            const before = buffer.slice(0, match.index);
            if (before.trim()) yield { type: "text-delta", text: before };
            const parsed = tryParseToolCall(match[1] ?? "");
            if (parsed) {
              emittedToolCall = true;
              seq += 1;
              yield {
                type: "tool-call",
                call: { id: `shim-${Date.now()}-${seq}`, name: parsed.name, input: parsed.input }
              };
            }
            buffer = buffer.slice(match.index + match[0].length);
          }
        } else if (ev.type === "done") {
          if (buffer.trim()) yield { type: "text-delta", text: buffer };
          yield { type: "done", stopReason: emittedToolCall ? "tool_use" : ev.stopReason };
        } else {
          yield ev;
        }
      }
    }
  };
}

function buildShimSystemPrompt(system: string, tools: ToolDef[]): string {
  if (tools.length === 0) return system;
  const catalog = tools
    .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.inputSchema)}`)
    .join("\n");
  return [
    system,
    "",
    "You have access to the following tools. To call one, output a single line",
    'of the exact form: TOOL_CALL: {"name": "<tool name>", "input": {...}}',
    "and nothing else on that line. Wait for the result before continuing.",
    "Only call a tool when you actually need it.",
    "",
    "Available tools:",
    catalog
  ].join("\n");
}

function tryParseToolCall(json: string): { name: string; input: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(json) as { name?: unknown; input?: unknown };
    if (typeof parsed.name !== "string") return null;
    const input =
      parsed.input && typeof parsed.input === "object" ? (parsed.input as Record<string, unknown>) : {};
    return { name: parsed.name, input };
  } catch {
    return null;
  }
}
