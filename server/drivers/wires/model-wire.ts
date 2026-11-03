import type { EffortLevel, ModelCatalog } from "../../contracts.ts";
import type { ChatToolDefinition } from "../chat-mcp-tools.ts";
import type { Completion, OpenAIChatMessage } from "../openai-chat.ts";
import type { ResponseItem } from "../openai-responses.ts";
import { ChatProtocolError, object } from "../openai-chat-protocol.ts";

export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface WireStreamHandlers {
  onBytes(): void;
  onDelta(delta: string, kind: "assistant_text" | "reasoning_text"): void;
  fail(status: number, body: string): Error;
}

/** A model API the chat runtime speaks. The runtime keeps Chat-shaped messages; a wire translates them on the way out and
 * its reply stream on the way in. `replay` hands back the provider's own output items for an assistant message of this
 * turn, which a wire returns as `Completion.responseOutput` when the provider needs them sent back untouched. */
export interface ModelWire {
  request(input: {
    model: string;
    messages: readonly OpenAIChatMessage[];
    tools: readonly ChatToolDefinition[];
    effort?: EffortLevel;
    replay(message: OpenAIChatMessage): ResponseItem[] | undefined;
  }): WireRequest;
  read(body: ReadableStream<Uint8Array> | null, handlers: WireStreamHandlers): Promise<Completion>;
  models(signal: AbortSignal): Promise<ModelCatalog["options"]>;
  liveness(): { url: string; headers: Record<string, string> };
}

const MAX_FRAME_CHARS = 16_000_000;

/** Reads a server-sent event stream whose `data:` lines are JSON objects. `consume` returns true at the last event; the
 * result says whether one did before the stream closed. */
export async function readSseJson(
  body: ReadableStream<Uint8Array> | null,
  onBytes: () => void,
  consume: (event: Record<string, unknown>) => boolean,
): Promise<boolean> {
  if (!body) throw new ChatProtocolError("The model API returned no response body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const line = (raw: string): boolean => {
    const text = raw.trim();
    if (!text.startsWith("data:")) return false;
    const data = text.slice(5).trim();
    if (!data || data === "[DONE]") return false;
    let event: Record<string, unknown> | undefined;
    try { event = object(JSON.parse(data)); }
    catch { throw new ChatProtocolError("The model API stream contained a malformed event"); }
    return event ? consume(event) : false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        return buffer.trim() ? line(buffer) : false;
      }
      onBytes();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_FRAME_CHARS) throw new ChatProtocolError("The model API stream frame exceeded the size limit");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const next = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line(next)) return true;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const NON_CHAT_MODEL = /(embedding|tts|transcribe|realtime|moderation|whisper|dall-e|image|audio|search-preview)/i;

/** The rows of an OpenAI-shaped `/models` answer, `{ data: [{ id }] }` or a bare list, that can hold a conversation. */
export function chatModelRows(json: unknown): ModelCatalog["options"] {
  const rows = Array.isArray(json) ? json : Array.isArray(object(json)?.data) ? object(json)!.data as unknown[] : [];
  const seen = new Set<string>();
  const options: ModelCatalog["options"] = [];
  for (const row of rows) {
    const id = object(row)?.id;
    if (typeof id !== "string" || !id.trim() || seen.has(id) || NON_CHAT_MODEL.test(id)) continue;
    seen.add(id);
    options.push({ id, label: id, custom: true });
  }
  return options;
}

export async function fetchModelRows(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** The runtime hands a call's result back as `{ ok, result }`. */
export function toolResultOf(content: OpenAIChatMessage["content"]): { text: string; failed: boolean } {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  try {
    const parsed = object(JSON.parse(text));
    if (parsed && typeof parsed.ok === "boolean" && typeof parsed.result === "string") return { text: parsed.result, failed: !parsed.ok };
  } catch {}
  return { text, failed: false };
}

/** A data URL as its media type and base64 payload, or null for a web address. */
export function inlineImage(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1]!, data: match[2]! } : null;
}
