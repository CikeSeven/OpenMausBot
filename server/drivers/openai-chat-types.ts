import type { DriverCreateInput, EffortLevel, ModelCatalog, SendTurnInput } from "../contracts.ts";
import type { ChatContentPart } from "./chat-images.ts";
import type { ChatToolCall } from "./openai-chat-protocol.ts";
import type { ProviderBody } from "./openai-chat-refusals.ts";
import type { ChatToolDefinition, ChatToolSession } from "./chat-mcp-tools.ts";
import type { SubagentLimits } from "./chat-subagents.ts";
import type { ModelWire } from "./wires/model-wire.ts";
import type { ToolScope } from "../../shared/tool-scope.ts";
import type { ResponseItem } from "./openai-responses.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Record<string, unknown>[];
}

export interface Usage {
  input: number;
  output: number;
}

export interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
  /** Every output item of a Responses API reply, encrypted reasoning included, for the next round of this turn only. */
  responseOutput?: ResponseItem[];
}

export interface CompletionJson extends ProviderBody {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  /** Groq reports streaming usage in its final x_groq envelope. */
  x_groq?: { usage?: CompletionJson["usage"] };
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
  incoming(completion: Completion): unknown;
}

export interface LocalToolContext {
  signal: AbortSignal;
  scope: ToolScope | undefined;
}

export interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  /** Speaks this model API instead of Chat Completions: it builds every request and reads every reply. */
  wire?: ModelWire;
  /** In-process tools listed before the turn's MCP tools. */
  localTools?: (turn: SendTurnInput, context: LocalToolContext) => ChatToolSession | undefined;
  /** Placed before the bot's own system prompt; it must not change between turns, or the cached prefix would. */
  basePrompt?: (turn: SendTurnInput) => string;
  effortLevels?: readonly EffortLevel[];
  /** A failed call is information the model reads and acts on, never a reason to end the turn; a refusal still is. */
  readsToolFailures?: boolean;
  /** Offers the delegate tool. Tools named in `concurrentTools` may run in several subagents at once; every other call
   * waits for the one before it, since a desktop or a browser tab serves one hand at a time. */
  subagents?: SubagentLimits & { concurrentTools: ReadonlySet<string> };
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean): Record<string, unknown>;
  httpErrorLabel: string;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  /** Ask a server on this machine or network for its models this often while a reply is pending, and stop the reply
   * when it misses LIVENESS_MISSES checks in a row: it crashed, froze or left the network. */
  livenessEveryMs?: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  /** Cerebras rejects `reasoning_content` and takes `reasoning`. */
  reasoningReplayField?: "reasoning_content" | "reasoning";
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  tools?: boolean;
  computerUse?: boolean;
  /** A text-only model keeps the computer and browser tools but never receives a screenshot or attachment. */
  imageInput?: (model: string) => boolean;
  /** The name to send for a model, when its server knows it by another. */
  servedModel?: (model: string) => Promise<string>;
  /** Smaller models announce a step and end the turn without calling a tool; such a reply gets a nudge, at most three
   * per turn and each only after tool progress since the last. */
  nudgeAnnouncedAction?: boolean;
  /** A model on this machine or network: read a tool call it wrote as text, stop it repeating itself, and send it back
   * to fix a failed call instead of ending the turn on it. */
  localModel?: boolean;
}

