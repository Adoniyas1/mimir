import type { BrainMessage, BrainProvider, StopReason, ToolDef, ToolResult } from "../brain/Provider.js";
import type { EffortLevel } from "../../shared/types.js";

export interface AgentLoopOptions {
  provider: BrainProvider;
  system: string;
  tools: ToolDef[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolResult>>;
  /** Hard ceiling on tool-call round-trips per user turn, so a confused
   *  model (especially a shimmed local one) can't loop forever. */
  maxToolIterations?: number;
  effort?: EffortLevel;
  webSearchEnabled?: boolean;
}

export type AgentStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean }
  /** A tool result carried images (see ToolResult.images) — shown to the
   * user directly, never fed back into the model's own conversation. */
  | { type: "tool-image"; dataUrl: string }
  | { type: "turn-done" }
  | { type: "error"; message: string };

/**
 * Drives one user turn to completion: sends the conversation to the active
 * BrainProvider, executes any tool calls it requests via the provided
 * handlers, feeds results back, and repeats until the model stops calling
 * tools or the iteration cap is hit. Provider-agnostic — works identically
 * whether `provider` is Claude, a local Ollama model, or a VPS endpoint.
 */
export async function* runAgentTurn(
  history: BrainMessage[],
  opts: AgentLoopOptions
): AsyncGenerator<AgentStreamEvent, BrainMessage[], unknown> {
  const messages = [...history];
  const maxIterations = opts.maxToolIterations ?? 8;
  const tools = opts.provider.supportsTools() ? opts.tools : [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let assistantText = "";
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let stopReason: StopReason = "end_turn";
    let sawError = false;

    for await (const ev of opts.provider.chat(messages, tools, {
      system: opts.system,
      effort: opts.effort,
      webSearchEnabled: opts.webSearchEnabled
    })) {
      if (ev.type === "text-delta") {
        assistantText += ev.text;
        yield { type: "text", text: ev.text };
      } else if (ev.type === "tool-call") {
        toolCalls.push(ev.call);
      } else if (ev.type === "error") {
        sawError = true;
        yield { type: "error", message: ev.message };
      } else if (ev.type === "done") {
        stopReason = ev.stopReason;
      }
    }

    if (sawError) return messages;

    messages.push({
      role: "assistant",
      content: assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });

    if (toolCalls.length === 0 || stopReason !== "tool_use") {
      yield { type: "turn-done" };
      return messages;
    }

    for (const call of toolCalls) {
      yield { type: "tool-start", name: call.name };
      const handler = opts.handlers[call.name];
      let result: ToolResult;
      if (!handler) {
        result = { content: `Unknown tool: ${call.name}`, isError: true };
      } else {
        try {
          result = await handler(call.input);
        } catch (err) {
          result = { content: err instanceof Error ? err.message : String(err), isError: true };
        }
      }
      yield { type: "tool-end", name: call.name, isError: result.isError ?? false };
      for (const img of result.images ?? []) {
        yield { type: "tool-image", dataUrl: `data:image/png;base64,${img}` };
      }
      messages.push({
        role: "tool",
        content: result.content,
        toolCallId: call.id,
        isError: result.isError
      });
    }
  }

  yield {
    type: "error",
    message: `Stopped after ${maxIterations} tool-call rounds without finishing — the model may be stuck.`
  };
  return messages;
}
