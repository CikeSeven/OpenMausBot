// Anthropic's Messages API, or any server that speaks it. Thinking runs adaptive with the chosen effort and comes back
// summarized; each reply's content blocks, thinking and its signature included, go back untouched for the rest of the
// turn. https://platform.claude.com/docs/en/build-with-claude/extended-thinking
import type { EffortLevel } from "../../contracts.ts";
import type { ChatContentPart } from "../chat-images.ts";
import type { ChatToolDefinition } from "../chat-mcp-tools.ts";
import type { Completion, OpenAIChatMessage } from "../openai-chat.ts";
import type { ResponseItem } from "../openai-responses.ts";
import { ChatProtocolError, ChatToolCalls, object } from "../openai-chat-protocol.ts";
import { fetchModelRows, inlineImage, readSseJson, toolResultOf, type ModelWire, type WireStreamHandlers } from "./model-wire.ts";

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 32_000;
/** A streamed request has no HTTP timeout to fit under, so it may ask for this many when the model allows it. */
const STREAMED_MAX_TOKENS = 64_000;
const EPHEMERAL = { type: "ephemeral" } as const;

type Block = Record<string, unknown>;
interface WireMessage { role: "user" | "assistant"; content: Block[] }

function contentBlocks(content: string | ChatContentPart[] | null): Block[] {
  if (content === null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.flatMap((part): Block[] => {
    if (part.type === "text") return part.text ? [{ type: "text", text: part.text }] : [];
    const inline = inlineImage(part.image_url.url);
    return [{ type: "image", source: inline ? { type: "base64", media_type: inline.mediaType, data: inline.data } : { type: "url", url: part.image_url.url } }];
  });
}

function argumentsOf(text: string): unknown {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

export function anthropicMessages(messages: readonly OpenAIChatMessage[], replay: (message: OpenAIChatMessage) => ResponseItem[] | undefined): WireMessage[] {
  const wire: WireMessage[] = [];
  const push = (role: WireMessage["role"], content: Block[]) => {
    if (!content.length) return;
    const last = wire.at(-1);
    if (last?.role === role) last.content.push(...content);
    else wire.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const result = toolResultOf(message.content);
      push("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: result.text || "(empty result)", ...(result.failed ? { is_error: true } : {}) }]);
    } else if (message.role === "assistant") {
      const native = replay(message);
      push("assistant", native ? native.filter((block) => block.type !== "text" || block.text).map((block) => ({ ...block })) : [
        ...contentBlocks(message.content),
        ...(message.tool_calls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: argumentsOf(call.function.arguments) })),
      ]);
    } else push("user", contentBlocks(message.content));
  }
  const tail = wire.at(-1)?.content.at(-1);
  if (tail) tail.cache_control = EPHEMERAL;
  return wire;
}

export function anthropicRequest(input: {
  model: string;
  messages: readonly OpenAIChatMessage[];
  tools: readonly ChatToolDefinition[];
  effort?: EffortLevel;
  maxTokens: number;
  replay(message: OpenAIChatMessage): ResponseItem[] | undefined;
}): Record<string, unknown> {
  const system = input.messages.filter((message) => message.role === "system" && typeof message.content === "string" && message.content)
    .map((message) => message.content as string).join("\n\n");
  const tools = input.tools.map(({ function: { name, description, parameters } }, index, all) => ({
    name, description, input_schema: parameters, ...(index === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
  const thinks = input.effort !== undefined && input.effort !== "none";
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    stream: true,
    ...(system ? { system: [{ type: "text", text: system, cache_control: EPHEMERAL }] } : {}),
    messages: anthropicMessages(input.messages, input.replay),
    ...(tools.length ? { tools } : {}),
    ...(thinks ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: input.effort } } : {}),
  };
}

const STOP_REASONS: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", model_context_window_exceeded: "length", pause_turn: "pause_turn" };

export async function readAnthropicStream(body: ReadableStream<Uint8Array> | null, handlers: WireStreamHandlers): Promise<Completion> {
  const blocks = new Map<number, Block & { partial?: string }>();
  const calls = new ChatToolCalls();
  let text = "";
  let reasoning = "";
  let lastText: number | undefined;
  let lastThought: number | undefined;
  let stopReason: string | null = null;
  let refusal: string | undefined;
  let input = 0;
  let output = 0;
  let callCount = 0;
  const say = (delta: string, index: number) => {
    if (!delta) return;
    const piece = (text && index !== lastText ? "\n\n" : "") + delta;
    lastText = index;
    text += piece;
    handlers.onDelta(piece, "assistant_text");
  };
  const think = (delta: string, index: number) => {
    if (!delta) return;
    const piece = (reasoning && index !== lastThought ? "\n\n" : "") + delta;
    lastThought = index;
    reasoning += piece;
    handlers.onDelta(piece, "reasoning_text");
  };
  const ended = await readSseJson(body, handlers.onBytes, (event) => {
    switch (event.type) {
      case "message_start": {
        const usage = object(object(event.message)?.usage);
        input = Number(usage?.input_tokens ?? 0) + Number(usage?.cache_creation_input_tokens ?? 0) + Number(usage?.cache_read_input_tokens ?? 0);
        output = Number(usage?.output_tokens ?? 0);
        return false;
      }
      case "content_block_start": {
        const block = object(event.content_block);
        if (block && typeof event.index === "number") {
          blocks.set(event.index, { ...block, ...(block.type === "tool_use" ? { input: {}, partial: "" } : {}) });
          if (block.type === "text") say(String(block.text ?? ""), event.index);
          if (block.type === "thinking") think(String(block.thinking ?? ""), event.index);
        }
        return false;
      }
      case "content_block_delta": {
        const delta = object(event.delta);
        const block = typeof event.index === "number" ? blocks.get(event.index) : undefined;
        if (!delta || !block) return false;
        const index = event.index as number;
        if (delta.type === "text_delta" && typeof delta.text === "string") { block.text = String(block.text ?? "") + delta.text; say(delta.text, index); }
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") { block.thinking = String(block.thinking ?? "") + delta.thinking; think(delta.thinking, index); }
        else if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = String(block.signature ?? "") + delta.signature;
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.partial += delta.partial_json;
        return false;
      }
      case "content_block_stop": {
        const block = typeof event.index === "number" ? blocks.get(event.index) : undefined;
        if (block?.type === "tool_use") {
          const args = block.partial || "{}";
          try { block.input = JSON.parse(args); } catch { throw new ChatProtocolError("The model wrote a tool call that is not complete JSON"); }
          delete block.partial;
          calls.add([{ index: callCount++, id: block.id, type: "function", function: { name: block.name, arguments: args } }], true);
        }
        return false;
      }
      case "message_delta": {
        const delta = object(event.delta);
        if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
        const details = object(delta?.stop_details);
        if (stopReason === "refusal") refusal = typeof details?.explanation === "string" ? details.explanation : typeof details?.category === "string" ? details.category : "";
        const usage = object(event.usage);
        if (typeof usage?.output_tokens === "number") output = usage.output_tokens;
        return false;
      }
      case "message_stop":
        return true;
      case "error": {
        const error = object(event.error);
        const status = error?.type === "overloaded_error" ? 529 : error?.type === "rate_limit_error" ? 429 : error?.type === "api_error" ? 500 : 400;
        throw handlers.fail(status, JSON.stringify(event));
      }
      default:
        return false;
    }
  });
  if (!ended) throw new ChatProtocolError("Stream ended before completion");
  if (refusal !== undefined) throw new ChatProtocolError(`The model declined this request${refusal ? `: ${refusal}` : "."}`);
  const finishReason = stopReason === null ? null : STOP_REASONS[stopReason] ?? stopReason;
  return {
    text, reasoning, finishReason,
    usage: { input, output },
    toolCalls: calls.finish(finishReason, false),
    protocolReasoning: "",
    protocolReasoningDetails: [],
    responseOutput: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
  };
}

export function anthropicWire(url: string, key: string, options: { maxOutputTokens?: number } = {}): ModelWire {
  const headers = () => ({ "x-api-key": key, "anthropic-version": API_VERSION });
  const modelMaxTokens = new Map<string, number>();
  return {
    request({ model, messages, tools, effort, replay }) {
      const maxTokens = options.maxOutputTokens ?? Math.min(modelMaxTokens.get(model) ?? DEFAULT_MAX_TOKENS, STREAMED_MAX_TOKENS);
      return { url: `${url}/messages`, headers: headers(), body: anthropicRequest({ model, messages, tools, effort, maxTokens, replay }) };
    },
    read: readAnthropicStream,
    async models(signal) {
      const json = object(await fetchModelRows(`${url}/models?limit=1000`, headers(), signal));
      const rows = Array.isArray(json?.data) ? json.data : [];
      return rows.flatMap((row) => {
        const entry = object(row);
        if (typeof entry?.id !== "string" || !entry.id) return [];
        if (typeof entry.max_tokens === "number" && entry.max_tokens > 0) modelMaxTokens.set(entry.id, entry.max_tokens);
        const label = typeof entry.display_name === "string" && entry.display_name ? entry.display_name : entry.id;
        const contextWindow = typeof entry.max_input_tokens === "number" ? entry.max_input_tokens : undefined;
        return [{ id: entry.id, label, custom: true as const, ...(contextWindow ? { contextWindow } : {}) }];
      });
    },
    liveness: () => ({ url: `${url}/models?limit=1`, headers: headers() }),
  };
}
