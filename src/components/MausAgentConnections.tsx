import { useState } from "react";
import { Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { MAUS_AGENT_DRIVER, MAUS_DEFAULT_URLS, MAUS_INSTANCE_PREFIX, MAUS_WIRES, type MausWire } from "../../shared/maus-agent";
import { KEY_FIELD } from "./keys/KeyRow";
import { modelIds } from "./OpenAiCompatServers";
import { Select } from "./Select";
import { SettingsGroup } from "./SettingsPrimitives";

const INPUT = cn(KEY_FIELD, "font-sans");
const ICON_BUTTON = "ui-icon-button shrink-0 hover:text-ink";

const WIRE_LABELS: Readonly<Record<MausWire, LocaleKey>> = {
  "openai-responses": "mausAgent.wire.responses",
  "openai-chat": "mausAgent.wire.chat",
  anthropic: "mausAgent.wire.anthropic",
  gemini: "mausAgent.wire.gemini",
};

type Connection = InstanceInfo & { mausConnection?: { wire?: MausWire; url?: string } };

export function isMausConnection(instance: Pick<InstanceInfo, "driverKind" | "instanceId">): boolean {
  return instance.driverKind === MAUS_AGENT_DRIVER && instance.instanceId.startsWith(MAUS_INSTANCE_PREFIX);
}

export function MausAgentConnections() {
  const { state, dispatch, refreshInstances } = useStore();
  const connections = state.instances.filter(isMausConnection) as Connection[];
  const [name, setName] = useState("");
  const [wire, setWire] = useState<MausWire>("openai-responses");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState<"add" | "other" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(name.trim() && key.trim());

  const run = (kind: "add" | "other", request: () => Promise<{ instances?: unknown }>, onDone?: () => void) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    void request()
      .then(async ({ instances }) => {
        if (Array.isArray(instances)) dispatch({ type: "instances", instances: instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
        onDone?.();
      })
      .catch((e: Error) => setError(e.message || t("mausAgent.failed")))
      .finally(() => setBusy(null));
  };

  const add = () => ready && run(
    "add",
    () => api("/api/instances/maus", {
      method: "POST",
      body: JSON.stringify({
        displayName: name.trim(), wire, key: key.trim(),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(modelIds(models).length ? { models: modelIds(models) } : {}),
      }),
    }),
    () => { setName(""); setUrl(""); setKey(""); setModels(""); },
  );

  return (
    <SettingsGroup label={t("mausAgent.title")} block="maus-agent">
      <div data-maus-agent className="px-4">
        <p className="mb-2 text-[12px] leading-4 text-ink-secondary">{t("mausAgent.subtitle")}</p>
        {connections.length === 0 && <p className="text-[12px] leading-4 text-ink-secondary">{t("mausAgent.empty")}</p>}
        {connections.map((connection) => (
          <div key={connection.instanceId} data-maus-connection={connection.instanceId}
            className="mb-1.5 flex items-center justify-between gap-2 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-ink">{connection.displayName}</div>
              <div className="truncate font-mono text-[11px] text-ink-secondary">
                {[connection.mausConnection?.wire ? t(WIRE_LABELS[connection.mausConnection.wire]) : null, connection.mausConnection?.url].filter(Boolean).join(" · ")}
              </div>
              {connection.snapshot.state === "unavailable" && connection.snapshot.reason && (
                <div className="truncate text-[11px] text-danger">{connection.snapshot.reason}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => run("other", () => api(`/api/instances/${encodeURIComponent(connection.instanceId)}/refresh-models`, { method: "POST" }))}
              disabled={busy !== null}
              aria-label={t("apiInstances.refreshModels", { name: connection.displayName })}
              title={t("apiInstances.refreshModels", { name: connection.displayName })}
              className={ICON_BUTTON}
            >
              <RotateCw size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => run("other", () => api(`/api/instances/${encodeURIComponent(connection.instanceId)}`, { method: "DELETE" }))}
              disabled={busy !== null}
              aria-label={t("apiInstances.remove", { name: connection.displayName })}
              title={t("apiInstances.remove", { name: connection.displayName })}
              className={`${ICON_BUTTON} hover:bg-danger/10 hover:text-danger`}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
        <div className="mt-2 flex flex-col gap-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("apiInstances.name")} aria-label={t("apiInstances.name")}
            spellCheck={false} disabled={busy !== null} className={INPUT} />
          <Select value={wire} onChange={(event) => setWire(event.target.value as MausWire)} disabled={busy !== null} aria-label={t("mausAgent.wire")}>
            {MAUS_WIRES.map((option) => <option key={option} value={option}>{t(WIRE_LABELS[option])}</option>)}
          </Select>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={MAUS_DEFAULT_URLS[wire]} aria-label={t("apiInstances.url")}
            spellCheck={false} disabled={busy !== null} className={cn(INPUT, "font-mono")} />
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("apiInstances.key")} aria-label={t("apiInstances.key")}
            autoComplete="off" disabled={busy !== null} className={cn(INPUT, "font-mono")} />
          <input value={models} onChange={(e) => setModels(e.target.value)} placeholder={t("apiInstances.models")} aria-label={t("apiInstances.models")}
            spellCheck={false} disabled={busy !== null} className={cn(INPUT, "font-mono")} />
          <p className="text-[12px] leading-4 text-ink-secondary">{t("apiInstances.modelsHint")}</p>
          <button type="button" onClick={add} disabled={busy !== null || !ready} className="ui-button self-start">
            {busy === "add" ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : <Plus size={12} aria-hidden="true" />}
            {busy === "add" ? t("apiInstances.adding") : t("mausAgent.add")}
          </button>
        </div>
        {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      </div>
    </SettingsGroup>
  );
}
