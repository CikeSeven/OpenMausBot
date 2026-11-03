// The built-in agent: OpenMausBot's own tool loop on a model API, with no agent CLI between them.
import { z } from "zod";
import type { EffortLevel, ModelCatalog, ProviderDriver } from "../../contracts.ts";
import { MAUS_AGENT_DRIVER, MAUS_DEFAULT_URLS, MAUS_WIRES, type MausWire } from "../../../shared/maus-agent.ts";
import { createOpenAIChatRuntime } from "../openai-chat.ts";
import { onThisNetwork } from "../openai-compat.ts";
import { chatModelRows, fetchModelRows, type ModelWire } from "../wires/model-wire.ts";
import { anthropicWire } from "../wires/anthropic.ts";
import { geminiWire } from "../wires/gemini.ts";
import { responsesWire } from "../wires/responses.ts";
import { mausBasePrompt } from "./prompt.ts";
import { WORKSPACE_TOOL_NAMES, workspaceTools } from "./workspace-tools.ts";

const DRIVER_KIND = "mausAgent" satisfies typeof MAUS_AGENT_DRIVER;

const configSchema = z.object({
  wire: z.enum(MAUS_WIRES).default("openai-responses"),
  url: z.string().trim().max(512).optional(),
  key: z.string().trim().max(4096).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  replyWaitMinutes: z.number().int().min(1).max(60).optional(),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
});

export interface MausAgentConfig {
  wire: MausWire;
  url: string;
  key?: string;
  models?: string[];
  model?: string;
  replyWaitMinutes?: number;
  maxOutputTokens?: number;
}

function decodeConfig(raw: unknown): MausAgentConfig {
  const config = configSchema.parse(raw ?? {});
  const url = new URL(config.url || MAUS_DEFAULT_URLS[config.wire]);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The base URL must use http or https.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The base URL must not carry a user name, password or query string.");
  return {
    wire: config.wire,
    url: `${url.origin}${url.pathname}`.replace(/\/+$/, ""),
    ...(config.key ? { key: config.key } : {}),
    ...(config.models?.length ? { models: [...new Set(config.models)] } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.replyWaitMinutes ? { replyWaitMinutes: config.replyWaitMinutes } : {}),
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
  };
}

const EFFORT_LEVELS: Readonly<Record<MausWire, readonly EffortLevel[] | undefined>> = {
  "openai-responses": ["low", "medium", "high", "xhigh", "max"],
  "openai-chat": undefined,
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["none", "low", "medium", "high"],
};

function wireFor(config: MausAgentConfig, key: string): ModelWire | undefined {
  const limits = config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {};
  switch (config.wire) {
    case "openai-responses": return responsesWire(config.url, key);
    case "openai-chat": return undefined;
    case "anthropic": return anthropicWire(config.url, key, limits);
    case "gemini": return geminiWire(config.url, key, limits);
  }
}

function seededCatalog(config: MausAgentConfig): ModelCatalog {
  const ids = [...new Set([...(config.model ? [config.model] : []), ...(config.models ?? [])])];
  return { default: ids[0] ?? "", options: ids.map((id) => ({ id, label: id, custom: true })) };
}

const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const SUBAGENT_LIMITS = { perTurn: 8, concurrent: 4, rounds: 40 };

export const MausAgentDriver: ProviderDriver<MausAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Built-in agent", supportsMultipleInstances: true, access: "api" },
  models: { default: "", options: [] },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input) {
    const { config } = input;
    const key = config.key ?? "";
    const apiKey = key || (onThisNetwork(config.url) ? "local" : "");
    const wire = wireFor(config, apiKey);
    const seeded = seededCatalog(config);
    let catalog = seeded;
    const refreshModels = async () => {
      if (!apiKey || config.models?.length) return;
      try {
        const signal = AbortSignal.timeout(10_000);
        const listed = wire ? await wire.models(signal)
          : chatModelRows(await fetchModelRows(`${config.url}/models`, { authorization: `Bearer ${apiKey}` }, signal));
        if (!listed.length) return;
        const options = config.model && !listed.some((option) => option.id === config.model)
          ? [{ id: config.model, label: config.model, custom: true as const }, ...listed] : listed;
        catalog = { default: config.model ?? options[0]!.id, options };
      } catch {}
    };
    void refreshModels();
    const missingKey = "This built-in agent connection has no API key. Add one in Settings → AI → Built-in agent.";
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      ...(wire ? { wire } : {}),
      apiKey,
      apiUrl: config.url,
      models: () => catalog,
      refreshModels,
      requestBody: (model, messages, stream) => ({
        model, messages, stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(config.maxOutputTokens ? { max_tokens: config.maxOutputTokens } : {}),
      }),
      httpErrorLabel: "upstream",
      missingKeyError: missingKey,
      unavailableReason: missingKey,
      timeoutMs: config.replyWaitMinutes ? config.replyWaitMinutes * 60_000 : DEFAULT_IDLE_TIMEOUT_MS,
      reasoning: true,
      retryScale: 1,
      computerUse: true,
      localTools: (turn) => workspaceTools(turn),
      basePrompt: (turn) => mausBasePrompt(turn, { subagents: !turn.guestConfined }),
      subagents: { ...SUBAGENT_LIMITS, concurrentTools: new Set(WORKSPACE_TOOL_NAMES) },
      readsToolFailures: true,
      billing: "metered",
      includeUsageInCompleted: true,
      ...(EFFORT_LEVELS[config.wire] ? { effortLevels: EFFORT_LEVELS[config.wire] } : {}),
      nativeLog: {
        source: `mausAgent.${config.wire}`,
        outgoing: (_turn, messages, model, tools) => ({ model, messageCount: messages.length, tools: tools.map((tool) => tool.function.name) }),
        incoming: ({ text, reasoning, usage, toolCalls }) => ({
          textLength: text.length, reasoningLength: reasoning.length, usage, toolCalls: toolCalls.map((call) => call.function.name),
        }),
      },
    });
  },
};
