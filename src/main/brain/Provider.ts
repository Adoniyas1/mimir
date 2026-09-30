/**
 * The provider-agnostic brain interface. Every place in the app that needs
 * "the model" talks to this interface only — never to @anthropic-ai/sdk,
 * fetch(), or any vendor SDK directly. This is what makes Mimir's brain
 * swappable (Claude / a local Ollama model / your own VPS) from Settings,
 * with no code changes and no rebuild.
 */

import type { BrainProviderKind, EffortLevel } from "../../shared/types.js";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Base64 PNGs (no data: prefix) to show alongside the reply — bypasses
   * the model's own text entirely, see the "image" ChatStreamEvent. Only
   * run_python sets this today (matplotlib figures). */
  images?: string[];
}

/** The one shape every build*Toolset() function returns. Was declared
 * identically five separate times (and inlined structurally three more)
 * before this consolidation — a single canonical import so a future
 * registry (e.g. dynamic skill-tools) has one type to depend on. */
export interface Toolset {
  defs: ToolDef[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>;
}

/**
 * A file the user attached to their message. `data` is base64 for
 * image/document, raw text for "text" (code/markdown/plain files — always
 * supported, every provider can read plain text, no vision needed).
 * "document" today means "PDF"; only Anthropic reads it natively (see
 * anthropicProvider.ts) — other providers get a plain-text note instead of
 * a half-working extraction pipeline.
 */
export interface Attachment {
  kind: "image" | "document" | "text";
  mimeType: string;
  data: string;
  name: string;
}

export type BrainMessage =
  | { role: "user"; content: string; attachments?: Attachment[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "system"; content: string }
  | { role: "tool"; content: string; toolCallId: string; isError?: boolean };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export type ChatEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "done"; stopReason: StopReason }
  | { type: "error"; message: string };

export interface ChatOpts {
  system: string;
  maxTokens?: number;
  /** Thinking-depth control. Anthropic-only; other providers ignore it. */
  effort?: EffortLevel;
  /** Enable the provider's native web-search capability, if it has one
   * (currently: Anthropic's server-side web_search tool). No-op elsewhere. */
  webSearchEnabled?: boolean;
}

/**
 * A model backend. Implementations must be side-effect-free to construct —
 * do network/auth validation lazily, on the first `chat()` call, so that
 * listing/selecting providers in Settings never makes a network request.
 */
export interface BrainProvider {
  readonly kind: BrainProviderKind;
  readonly model: string;

  /**
   * Whether this provider can reliably do native tool-calling. The agent
   * loop uses this to decide whether to enable the self-edit tool group
   * (see src/main/self-edit/tools.ts) — self-editing is disabled rather
   * than degraded when this is false.
   */
  supportsTools(): boolean;
  supportsVision(): boolean;

  chat(
    messages: BrainMessage[],
    tools: ToolDef[],
    opts: ChatOpts
  ): AsyncGenerator<ChatEvent, void, unknown>;
}

export class BrainConfigError extends Error {}
