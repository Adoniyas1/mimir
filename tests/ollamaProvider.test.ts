import { describe, it, expect, afterEach, vi } from "vitest";
import { OllamaProvider } from "../src/main/brain/ollamaProvider.js";
import type { ChatEvent, ToolDef } from "../src/main/brain/Provider.js";

/** Builds a fake streaming fetch() Response from a sequence of Ollama NDJSON
 * chunk objects, one per line, mirroring what /api/chat actually returns. */
function fakeStreamingResponse(chunks: Array<Record<string, unknown>>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
      }
      controller.close();
    }
  });
  return { ok: true, body } as unknown as Response;
}

async function collectEvents(gen: AsyncGenerator<ChatEvent, void, unknown>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const TOOLS: ToolDef[] = [
  { name: "create_skill", description: "d", inputSchema: { type: "object", properties: {} } },
  { name: "run_skill", description: "d", inputSchema: { type: "object", properties: {} } }
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OllamaProvider — leaked tool-call recovery", () => {
  it("recovers a tool call the model wrote directly into content instead of tool_calls (live-observed pattern)", async () => {
    const leaked = { name: "create_skill", parameters: { name: "webcam_identify", description: "Identify objects", code: "print('hi')" } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeStreamingResponse([
          { message: { content: JSON.stringify(leaked) } },
          { message: {}, done: true }
        ])
      )
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));

    const toolCallEvents = events.filter((e) => e.type === "tool-call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({ type: "tool-call", call: { name: "create_skill", input: leaked.parameters } });
    // The raw JSON must never reach the visible chat text.
    const visibleText = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    expect(visibleText).not.toContain("create_skill");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  });

  it("recovers a leaked tool call even when it's preceded by ordinary prose in the same reply", async () => {
    const leaked = { name: "run_skill", input: { name: "webcam_identify" } };
    const text = `Now I have the skill. Using \`run_skill\`:\n\n${JSON.stringify(leaked)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeStreamingResponse([{ message: { content: text } }, { message: {}, done: true }]))
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));

    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    const visibleText = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    // The prose mentioning the tool name in backticks is fine to keep —
    // it's the raw JSON blob itself that must never reach the chat.
    expect(visibleText).toContain("Now I have the skill. Using `run_skill`:");
    expect(visibleText).not.toContain(JSON.stringify(leaked));
    expect(visibleText).not.toContain('"input"');
  });

  it("recovers a leaked call whose code string contains braces, without miscounting them", async () => {
    const leaked = {
      name: "create_skill",
      parameters: { name: "x", description: "d", code: "def f():\n    d = {'a': 1}\n    return d" }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeStreamingResponse([{ message: { content: JSON.stringify(leaked) } }, { message: {}, done: true }])
      )
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));

    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ call: { name: "create_skill", input: leaked.parameters } });
  });

  it("leaves ordinary JSON-shaped text alone when its 'name' isn't a real tool for this turn", async () => {
    const notATool = { name: "totally_unknown_thing", parameters: { x: 1 } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeStreamingResponse([{ message: { content: JSON.stringify(notATool) } }, { message: {}, done: true }])
      )
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));

    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    const visibleText = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    expect(visibleText).toContain("totally_unknown_thing");
  });

  it("streams ordinary prose immediately, unaffected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeStreamingResponse([
          { message: { content: "Hello! " } },
          { message: { content: "How can I help?" } },
          { message: {}, done: true }
        ])
      )
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));
    const visibleText = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    expect(visibleText).toBe("Hello! How can I help?");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
  });

  it("recovers a syntactically-broken tool-call attempt (live-captured: stray quote before a key)", async () => {
    // Captured verbatim from a real llama3.2:3b response: a stray extra
    // quote right after the tool-selector "name" breaks strict JSON
    // parsing, but it's still unambiguously an attempted create_skill call.
    const broken =
      '{"name":"create_skill","' +
      '"code":"from openCV import cv2\\nimport numpy as np\\n\\ndef object_detection(image):\\n    return image",' +
      '"description":"Identify objects in an image using OpenCV",' +
      '"name":"object_detection"}}';
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeStreamingResponse([{ message: { content: broken } }, { message: {}, done: true }]))
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));

    const visibleText = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    expect(visibleText).not.toContain('"code"'); // raw broken JSON must never reach the chat

    const call = events.find((e) => e.type === "tool-call");
    expect(call).toBeTruthy();
    if (call?.type === "tool-call") {
      expect(call.call.name).toBe("create_skill");
      expect(call.call.input.description).toBe("Identify objects in an image using OpenCV");
      expect(call.call.input.name).toBe("object_detection"); // the skill's own name, not the tool selector
      expect(String(call.call.input.code)).toContain("def object_detection");
    }
  });

  it("suppresses an orphaned stray closing brace left after a resolved call", async () => {
    const leaked = { name: "create_skill", input: {} };
    // A doubled closing brace, as sometimes produced by a malformed
    // generation — the extra '}' has nothing to pair with.
    const text = `${JSON.stringify(leaked)}}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeStreamingResponse([{ message: { content: text } }, { message: {}, done: true }]))
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));

    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    const visibleText = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    expect(visibleText.trim()).toBe("");
  });

  it("still handles genuine native tool_calls (unaffected by the new buffering)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        fakeStreamingResponse([
          { message: { content: "", tool_calls: [{ function: { name: "create_skill", arguments: { name: "x" } } }] } },
          { message: {}, done: true }
        ])
      )
    );

    const provider = new OllamaProvider("llama3.2:3b");
    const events = await collectEvents(provider.chat([], TOOLS, { system: "sys" }));
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  });
});
