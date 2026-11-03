// Google's Gemini API (generateContent) with an API key. Tool schemas go as `parametersJsonSchema`, so they need no
// translation into Gemini's OpenAPI subset; each reply's parts, thought signatures included, go back untouched for the
// rest of the turn. https://ai.google.dev/gemini-api/docs/function-calling, https://ai.google.dev/gemini-api/docs/thought-signatures
import { randomUUID } from "node:crypto";
import type { EffortLevel } from "../../contracts.ts";
import type { ChatContentPart } from "../chat-images.ts";
import type { ChatToolDefinition } from "../chat-mcp-tools.ts";
import type { Completion, OpenAIChatMessage } from "../openai-chat.ts";
import type { ResponseItem } from "../openai-responses.ts";
import { ChatProtocolError, ChatToolCalls, object } from "../openai-chat-protocol.ts";
import { fetchModelRows, inlineImage, readSseJson, toolResultOf, type ModelWire, type WireStreamHandlers } from "./model-wire.ts";

type Part = Record<string, unknown>;
interface Content { role: "user" | "model"; parts: Part[] }

/** Gemini 2.x takes a thinking budget in tokens; later models take a level. */
const THINKING_BUDGETS: Partial<Record<EffortLevel, number>> = { none: 0, low: 1_024, medium: 8_192, high: 16_384, xhigh: 24_576, max: 32_768 };
const THINKING_LEVELS: Partial<Record<EffortLevel, string>> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/** Gemini 2.x calls carry no id; one made here to correlate the result is never sent back. */
const LOCAL_CALL_ID = "omb_call_";

function thinkingConfig(model: string, effort: EffortLevel | undefined): Record<string, unknown> | undefined {
  if (effort === undefined) return undefined;
  if (/^gemini-[12]\./.test(model)) return { includeThoughts: effort !== "none", thinkingBudget: THINKING_BUDGETS[effort] };
  const level = THINKING_LEVELS[effort];
  return level ? { includeThoughts: true, thinkingLevel: level } : { includeThoughts: false, thinkingLevel: "low" };
}

function parts(content: string | ChatContentPart[] | null): Part[] {
  if (content === null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return content.flatMap((part): Part[] => {
    if (part.type === "text") return part.text ? [{ text: part.text }] : [];
    const inline = inlineImage(part.image_url.url);
    return inline ? [{ inlineData: { mimeType: inline.mediaType, data: inline.data } }] : [{ fileData: { fileUri: part.image_url.url } }];
  });
}

function argumentsOf(text: string): unknown {
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

export function geminiContents(messages: readonly OpenAIChatMessage[], replay: (message: OpenAIChatMessage) => ResponseItem[] | undefined): Content[] {
  const contents: Content[] = [];
  const names = new Map<string, string>();
  const push = (role: Content["role"], added: Part[]) => {
    if (!added.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...added);
    else contents.push({ role, parts: added });
  };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      const native = replay(message);
      push("model", native ? native.map((part) => ({ ...part })) : [
        ...parts(message.content),
        ...(message.tool_calls ?? []).map((call) => ({ functionCall: {
          ...(call.id.startsWith(LOCAL_CALL_ID) ? {} : { id: call.id }), name: call.function.name, args: argumentsOf(call.function.arguments),
        } })),
      ]);
    } else if (message.role === "tool") {
      const result = toolResultOf(message.content);
      const id = message.tool_call_id ?? "";
      push("user", [{ functionResponse: {
        ...(id.startsWith(LOCAL_CALL_ID) ? {} : { id }), name: names.get(id) ?? "tool", response: result.failed ? { error: result.text } : { output: result.text },
      } }]);
    } else push("user", parts(message.content));
  }
  return contents;
}

export function geminiRequest(input: {
  model: string;
  messages: readonly OpenAIChatMessage[];
  tools: readonly ChatToolDefinition[];
  effort?: EffortLevel;
  maxOutputTokens?: number;
  replay(message: OpenAIChatMessage): ResponseItem[] | undefined;
}): Record<string, unknown> {
  const system = input.messages.filter((message) => message.role === "system" && typeof message.content === "string" && message.content)
    .map((message) => message.content as string).join("\n\n");
  const thinking = thinkingConfig(input.model, input.effort);
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: geminiContents(input.messages, input.replay),
    ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map(({ function: { name, description, parameters } }) => ({
      name, description, parametersJsonSchema: parameters,
    })) }] } : {}),
    generationConfig: { ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}), ...(thinking ? { thinkingConfig: thinking } : {}) },
  };
}

const FINISHED = new Set(["STOP", "FINISH_REASON_UNSPECIFIED"]);

export async function readGeminiStream(body: ReadableStream<Uint8Array> | null, handlers: WireStreamHandlers): Promise<Completion> {
  const kept: Part[] = [];
  const calls = new ChatToolCalls();
  let text = "";
  let reasoning = "";
  let finish: string | null = null;
  let input = 0;
  let output = 0;
  let callCount = 0;
  let saw = false;
  await readSseJson(body, handlers.onBytes, (event) => {
    const error = object(event.error);
    if (error) throw handlers.fail(typeof error.code === "number" ? error.code : 500, JSON.stringify(event));
    const usage = object(event.usageMetadata);
    if (usage) {
      input = Number(usage.promptTokenCount ?? 0);
      output = Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0);
    }
    const blocked = object(event.promptFeedback)?.blockReason;
    if (typeof blocked === "string") throw new ChatProtocolError(`Gemini blocked this request (${blocked}).`);
    const candidate = object(Array.isArray(event.candidates) ? event.candidates[0] : undefined);
    if (!candidate) return false;
    saw = true;
    if (typeof candidate.finishReason === "string") finish = candidate.finishReason;
    const received = object(candidate.content)?.parts;
    for (const raw of Array.isArray(received) ? received : []) {
      const part = object(raw);
      if (!part) continue;
      const call = object(part.functionCall);
      if (call) {
        const id = typeof call.id === "string" && call.id ? call.id : `${LOCAL_CALL_ID}${randomUUID().replaceAll("-", "")}`;
        kept.push({ ...part });
        calls.add([{ index: callCount++, id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }], true);
        continue;
      }
      if (typeof part.text === "string") {
        const last = kept.at(-1);
        const sameKind = last && typeof last.text === "string" && Boolean(last.thought) === Boolean(part.thought) && !part.thoughtSignature && !last.thoughtSignature;
        if (sameKind) last.text = String(last.text) + part.text;
        else kept.push({ ...part });
        if (part.thought) { reasoning += part.text; handlers.onDelta(part.text, "reasoning_text"); }
        else { text += part.text; handlers.onDelta(part.text, "assistant_text"); }
      } else kept.push({ ...part });
    }
    return false;
  });
  if (!saw) throw new ChatProtocolError("Gemini returned no reply");
  if (finish === null) throw new ChatProtocolError("Stream ended before completion");
  if (!FINISHED.has(finish) && finish !== "MAX_TOKENS") throw new ChatProtocolError(`Gemini stopped this reply (${finish}).`);
  const finishReason = callCount ? "tool_calls" : finish === "MAX_TOKENS" ? "length" : "stop";
  return {
    text, reasoning, finishReason,
    usage: { input, output },
    toolCalls: calls.finish(finishReason, false),
    protocolReasoning: "",
    protocolReasoningDetails: [],
    responseOutput: kept,
  };
}

export function geminiWire(url: string, key: string, options: { maxOutputTokens?: number } = {}): ModelWire {
  const headers = () => ({ "x-goog-api-key": key });
  const modelPath = (model: string) => model.startsWith("models/") || model.startsWith("tunedModels/") ? model : `models/${model}`;
  return {
    request: ({ model, messages, tools, effort, replay }) => ({
      url: `${url}/${modelPath(model)}:streamGenerateContent?alt=sse`,
      headers: headers(),
      body: geminiRequest({ model, messages, tools, effort, replay, ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) }),
    }),
    read: readGeminiStream,
    async models(signal) {
      const json = object(await fetchModelRows(`${url}/models?pageSize=1000`, headers(), signal));
      const rows = Array.isArray(json?.models) ? json.models : [];
      return rows.flatMap((row) => {
        const entry = object(row);
        const methods = Array.isArray(entry?.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
        if (typeof entry?.name !== "string" || !methods.includes("generateContent")) return [];
        const id = entry.name.replace(/^models\//, "");
        const label = typeof entry.displayName === "string" && entry.displayName ? entry.displayName : id;
        const contextWindow = typeof entry.inputTokenLimit === "number" ? entry.inputTokenLimit : undefined;
        return [{ id, label, custom: true as const, ...(contextWindow ? { contextWindow } : {}) }];
      });
    },
    liveness: () => ({ url: `${url}/models?pageSize=1`, headers: headers() }),
  };
}
