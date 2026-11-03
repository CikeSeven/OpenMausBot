/** The model APIs a built-in agent connection can speak. */
export const MAUS_WIRES = ["openai-responses", "openai-chat", "anthropic", "gemini"] as const;

export type MausWire = (typeof MAUS_WIRES)[number];

export function isMausWire(value: unknown): value is MausWire {
  return typeof value === "string" && (MAUS_WIRES as readonly string[]).includes(value);
}

/** The base URL a new connection of each kind starts with; the person may point it at any compatible server. */
export const MAUS_DEFAULT_URLS: Readonly<Record<MausWire, string>> = {
  "openai-responses": "https://api.openai.com/v1",
  "openai-chat": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

export const MAUS_AGENT_DRIVER = "mausAgent";
export const MAUS_INSTANCE_PREFIX = "maus-";
