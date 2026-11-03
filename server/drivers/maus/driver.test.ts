import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { bindSafetyFloor } from "../../safety-floor-gate.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { responsesReply, startFakeModelServer, type FakeModelCall, type FakeReply } from "../../testing/fake-model-server.ts";
import { MausAgentDriver } from "./driver.ts";

const MODEL = "relay-model";
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => ensureDirs());
afterEach(async () => {
  bindSafetyFloor(() => ({}));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(script: (call: FakeModelCall, nth: number) => FakeReply) {
  const server = await startFakeModelServer(script, { data: [{ id: MODEL }] });
  const folder = mkdtempSync(join(tmpdir(), "omb-maus-"));
  const instance: ProviderInstance = await MausAgentDriver.create({
    instanceId: `maus-${randomUUID()}`, displayName: "Relay", enabled: true, environment: {},
    config: MausAgentDriver.decodeConfig({ wire: "openai-responses", url: server.url, key: "fixture-key-81c2" }),
  });
  const recorder: EventRecorder = recordEvents(instance.adapter);
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    await server.close();
    await removeTempDir(folder);
  });
  const threadId = randomUUID();
  const turn = async (input: Partial<SendTurnInput> = {}) => {
    const seen = recorder.events.length;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "Do the task.", model: MODEL, cwd: folder, approvalMode: "full", ...input });
    const end = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return { end, events: recorder.events.slice(seen) };
  };
  const answerNextRequest = async (behavior: "allow" | "deny") => {
    const opened = await recorder.until((event) => event.type === "request.opened" && !recorder.events.some((later) =>
      later.type === "request.resolved" && later.requestId === (event as { requestId: string }).requestId)) as Extract<RuntimeEvent, { type: "request.opened" }>;
    await instance.adapter.respondToRequest(threadId, opened.requestId!, { behavior });
    return opened;
  };
  return { server, folder, instance, recorder, turn, answerNextRequest, threadId };
}

const toolOutputs = (call: FakeModelCall) => (call.body.input as Array<Record<string, any>>)
  .filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output) as { ok: boolean; result: string });

describe("the built-in agent on the Responses API", () => {
  it("writes a file with its own tool, then answers", async () => {
    const f = await fixture((_call, nth) => nth === 1
      ? responsesReply.calls({ id: "c1", name: "write_file", args: { path: "notes/hello.txt", content: "hi there\n" } })
      : responsesReply.text("Wrote notes/hello.txt."));
    const { end, events } = await f.turn();
    expect(end).toMatchObject({ ok: true });
    expect(readFileSync(join(f.folder, "notes/hello.txt"), "utf8")).toBe("hi there\n");
    expect(f.server.calls.map((call) => call.path)).toEqual(["/v1/responses", "/v1/responses"]);
    const first = f.server.calls[0]!;
    expect(first.headers.authorization).toBe("Bearer fixture-key-81c2");
    expect(first.body).toMatchObject({ model: MODEL, store: false, include: ["reasoning.encrypted_content"] });
    expect(first.body.instructions).toContain(`Your working folder is ${f.folder}`);
    expect((first.body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "write_file", "edit_file", "list_files", "search", "run_command"]));
    expect(toolOutputs(f.server.calls[1]!)).toEqual([{ ok: true, result: "Wrote 9 bytes to notes/hello.txt." }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "Wrote notes/hello.txt." }));
  });

  it("asks before writing in Ask, and writes once allowed", async () => {
    const f = await fixture((_call, nth) => nth === 1
      ? responsesReply.calls({ id: "c1", name: "write_file", args: { path: "a.txt", content: "A" } })
      : responsesReply.text("Done."));
    const running = f.turn({ approvalMode: "ask" });
    const opened = await f.answerNextRequest("allow");
    expect(opened).toMatchObject({ requestType: "permission", tool: "Write file", allowSession: true });
    expect((await running).end).toMatchObject({ ok: true });
    expect(readFileSync(join(f.folder, "a.txt"), "utf8")).toBe("A");
  });

  it("writes without asking in Auto-accept edits, but asks before writing outside its folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "omb-maus-outside-"));
    cleanups.push(() => removeTempDir(outside));
    const f = await fixture((_call, nth) => nth === 1
      ? responsesReply.calls(
        { id: "c1", name: "write_file", args: { path: "inside.txt", content: "in" } },
        { id: "c2", name: "write_file", args: { path: join(outside, "outside.txt"), content: "out" } })
      : responsesReply.text("Done."));
    const running = f.turn({ approvalMode: "edits" });
    const opened = await f.answerNextRequest("deny");
    expect(opened.summary).toContain("outside.txt");
    const { end } = await running;
    expect(readFileSync(join(f.folder, "inside.txt"), "utf8")).toBe("in");
    expect(() => readFileSync(join(outside, "outside.txt"))).toThrow();
    expect(end).toMatchObject({ ok: false, denials: ["Write file"] });
  });

  it("edits a file in place and reads it back numbered", async () => {
    const f = await fixture((_call, nth) => [
      responsesReply.calls({ id: "c1", name: "edit_file", args: { path: "app.py", old_string: "print('a')", new_string: "print('b')" } }),
      responsesReply.calls({ id: "c2", name: "read_file", args: { path: "app.py" } }),
      responsesReply.text("Changed it."),
    ][nth - 1]!);
    writeFileSync(join(f.folder, "app.py"), "import os\nprint('a')\n");
    expect((await f.turn()).end).toMatchObject({ ok: true });
    expect(readFileSync(join(f.folder, "app.py"), "utf8")).toBe("import os\nprint('b')\n");
    expect(toolOutputs(f.server.calls[2]!).at(-1)!.result).toBe("     1\timport os\n     2\tprint('b')");
  });

  it.skipIf(process.platform === "win32")("runs a command, streams what it prints, and reads a failing exit as information", async () => {
    const f = await fixture((_call, nth) => [
      responsesReply.calls({ id: "c1", name: "run_command", args: { command: "echo streamed && exit 3" } }),
      responsesReply.text("The command failed with exit code 3."),
    ][nth - 1]!);
    const { end, events } = await f.turn();
    expect(end).toMatchObject({ ok: true });
    expect(toolOutputs(f.server.calls[1]!)).toEqual([{ ok: false, result: "streamed\n[Exit code 3]" }]);
    expect(events).toContainEqual(expect.objectContaining({ type: "item.output", itemId: "c1", text: "streamed\n" }));
  });

  it.skipIf(process.platform === "win32")("asks before every command, even in Auto-accept edits", async () => {
    const f = await fixture((_call, nth) => nth === 1
      ? responsesReply.calls({ id: "c1", name: "run_command", args: { command: "touch made-by-command" } })
      : responsesReply.text("Done."));
    const running = f.turn({ approvalMode: "edits" });
    const opened = await f.answerNextRequest("deny");
    expect(opened).toMatchObject({ tool: "Run command" });
    expect(opened.summary).toContain("touch made-by-command");
    expect((await running).end).toMatchObject({ denials: ["Run command"] });
  });

  it.skipIf(process.platform === "win32")("stops a command at the safety floor even with Full access", async () => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }));
    const f = await fixture((_call, nth) => nth === 1
      ? responsesReply.calls({ id: "c1", name: "run_command", args: { command: "rm -rf /" } })
      : responsesReply.text("I could not do that."));
    const { end } = await f.turn();
    expect(toolOutputs(f.server.calls[1]!)[0]!.result).toContain("safety floor");
    expect(end).toMatchObject({ denials: ["Run command"] });
  });

  it("offers no command tool in a guest turn, and refuses a read outside its folder", async () => {
    const f = await fixture((_call, nth) => nth === 1
      ? responsesReply.calls({ id: "c1", name: "read_file", args: { path: "/etc/hostname" } })
      : responsesReply.text("I can only read my own folder."));
    await f.turn({ guestConfined: true, confinedWhy: "Guests only see this folder." });
    expect((f.server.calls[0]!.body.tools as Array<{ name: string }>).map((tool) => tool.name)).not.toContain("run_command");
    expect(toolOutputs(f.server.calls[1]!)[0]!.result).toContain("Guests only see this folder.");
  });

  it("sends the chosen effort, and lists the connection's models", async () => {
    const f = await fixture(() => responsesReply.text("Hello."));
    await f.turn({ effort: "high" });
    expect(f.server.calls[0]!.body.reasoning).toEqual({ effort: "high", summary: "auto" });
    await f.instance.refreshModels?.();
    expect(f.instance.models.options.map((option) => option.id)).toEqual([MODEL]);
    expect(f.instance.adapter.capabilities.effortLevels).toContain("high");
  });
});
