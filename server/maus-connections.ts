import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { endpointBaseUrl, endpointDisplayUrl } from "./openai-compat-endpoints.ts";
import { MAUS_AGENT_DRIVER, MAUS_DEFAULT_URLS, MAUS_INSTANCE_PREFIX, MAUS_WIRES, isMausWire } from "../shared/maus-agent.ts";

export const addMausConnectionSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  wire: z.enum(MAUS_WIRES),
  url: z.string().max(512).optional(),
  key: z.string().trim().max(4096).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
}).strict();

export type AddMausConnection = z.infer<typeof addMausConnectionSchema>;

export function isMausConnection(instanceId: string, entry: InstanceConfig | undefined): boolean {
  return entry?.driver === MAUS_AGENT_DRIVER && instanceId.startsWith(MAUS_INSTANCE_PREFIX);
}

export function addMausConnection(instances: InstanceConfigMap, body: AddMausConnection): { instanceId: string } | { error: string } {
  const url = endpointBaseUrl(body.url?.trim() || MAUS_DEFAULT_URLS[body.wire]);
  if (!url) return { error: "Enter an http or https base URL without a user name, password or query string." };
  if (body.key && /^https?:\/\//i.test(body.key)) return { error: "That API key looks like a URL. Paste the secret key itself, not a web address." };
  const instanceId = `${MAUS_INSTANCE_PREFIX}${randomUUID()}`;
  const models = [...new Set(body.models ?? [])];
  instances[instanceId] = {
    driver: MAUS_AGENT_DRIVER, displayName: body.displayName, access: "api",
    config: { wire: body.wire, url, ...(body.key ? { key: body.key } : {}), ...(models.length ? { models } : {}) },
  };
  return { instanceId };
}

/** Each connection as the instance list shows it: its API and address, never its key. */
export function withMausConnections(described: unknown, configs: InstanceConfigMap): unknown {
  if (!Array.isArray(described)) return described;
  return described.map((instance: { instanceId?: string }) => {
    const entry = instance.instanceId ? configs[instance.instanceId] : undefined;
    if (!entry || !isMausConnection(instance.instanceId!, entry)) return instance;
    const wire = (entry.config as { wire?: unknown } | undefined)?.wire;
    const url = endpointDisplayUrl(entry.config);
    return { ...instance, mausConnection: { ...(isMausWire(wire) ? { wire } : {}), ...(url ? { url } : {}) } };
  });
}
