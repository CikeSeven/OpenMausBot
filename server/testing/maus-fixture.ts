// A built-in agent connection against a fake model server, with a throwaway working folder.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { MausAgentDriver } from "../drivers/maus/driver.ts";
import type { MausWire } from "../../shared/maus-agent.ts";
import { removeTempDir } from "./cleanup.ts";
import { recordEvents, type EventRecorder } from "./events.ts";
import { startFakeModelServer, type FakeModelCall, type FakeModelServer, type FakeReply } from "./fake-model-server.ts";

export interface MausFixture {
  server: FakeModelServer;
  folder: string;
  instance: ProviderInstance;
  recorder: EventRecorder;
  threadId: string;
  turn(input?: Partial<SendTurnInput>): Promise<{ end: RuntimeEvent; events: RuntimeEvent[] }>;
  /** Answers the oldest permission or question card still open, once it appears. */
  answerNextRequest(behavior: "allow" | "deny"): Promise<Extract<RuntimeEvent, { type: "request.opened" }>>;
  close(): Promise<void>;
}

export async function mausFixture(options: {
  wire: MausWire;
  model: string;
  script: (call: FakeModelCall, nth: number) => FakeReply;
  models?: unknown;
}): Promise<MausFixture> {
  const server = await startFakeModelServer(options.script, options.models ?? { data: [{ id: options.model }] });
  const folder = mkdtempSync(join(tmpdir(), "omb-maus-"));
  const instance = await MausAgentDriver.create({
    instanceId: `maus-${randomUUID()}`, displayName: "Fixture", enabled: true, environment: {},
    config: MausAgentDriver.decodeConfig({ wire: options.wire, url: server.url, key: "fixture-key-81c2" }),
  });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  const answered = new Set<string>();
  return {
    server, folder, instance, recorder, threadId,
    async turn(input = {}) {
      const seen = recorder.events.length;
      const { turnId } = await instance.adapter.sendTurn({
        threadId, text: "Do the task.", model: options.model, cwd: folder, approvalMode: "full", ...input,
      });
      const end = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      return { end, events: recorder.events.slice(seen) };
    },
    async answerNextRequest(behavior) {
      const opened = await recorder.until((event) => event.type === "request.opened" && !answered.has(event.requestId!)) as
        Extract<RuntimeEvent, { type: "request.opened" }>;
      answered.add(opened.requestId!);
      await instance.adapter.respondToRequest(threadId, opened.requestId!, { behavior });
      return opened;
    },
    async close() {
      recorder.stop();
      await instance.dispose();
      await server.close();
      await removeTempDir(folder);
    },
  };
}
