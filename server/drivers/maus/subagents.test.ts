import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import { responsesReply, type FakeModelCall, type FakeReply } from "../../testing/fake-model-server.ts";
import { mausFixture, type MausFixture } from "../../testing/maus-fixture.ts";

const MODEL = "relay-model";
const fixtures: MausFixture[] = [];
beforeAll(() => ensureDirs());
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

const subagentTask = (call: FakeModelCall): string | undefined => {
  const first = (call.body.input as Array<{ role?: string; content?: unknown }>).find((item) => item.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  return text.startsWith("You are a subagent") ? /^Task: (.*)$/m.exec(text)?.[1] : undefined;
};
const toolNames = (call: FakeModelCall) => (call.body.tools as Array<{ name: string }>).map((tool) => tool.name);
const outputsOf = (call: FakeModelCall) => (call.body.input as Array<Record<string, any>>)
  .filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output) as { ok: boolean; result: string });

async function fixture(parent: (call: FakeModelCall, nth: number) => FakeReply, subagent: (task: string, call: FakeModelCall, nth: number) => FakeReply) {
  let parentCalls = 0;
  const subagentCalls = new Map<string, number>();
  const made = await mausFixture({
    wire: "openai-responses", model: MODEL,
    script: (call) => {
      const task = subagentTask(call);
      if (task === undefined) return parent(call, ++parentCalls);
      const nth = (subagentCalls.get(task) ?? 0) + 1;
      subagentCalls.set(task, nth);
      return subagent(task, call, nth);
    },
  });
  fixtures.push(made);
  return made;
}

const delegate = (...titles: string[]) => responsesReply.calls({
  id: `d_${titles.join("_").replace(/\W/g, "")}`, name: "delegate",
  args: { tasks: titles.map((title) => ({ title, prompt: `Read ${title}.txt and hand back its first line.` })) },
});

describe("the built-in agent's subagents", () => {
  it("run in parallel on their own task alone, and hand back only their answers", async () => {
    const f = await fixture(
      (_call, nth) => nth === 1 ? delegate("alpha", "beta") : responsesReply.text("alpha says A, beta says B."),
      (task, _call, nth) => nth === 1
        ? responsesReply.calls({ id: `r_${task}`, name: "read_file", args: { path: `${task}.txt` } })
        : responsesReply.text(`First line of ${task}: ${task.toUpperCase()}`),
    );
    writeFileSync(join(f.folder, "alpha.txt"), "A\n");
    writeFileSync(join(f.folder, "beta.txt"), "B\n");
    const { end, events } = await f.turn();
    expect(end).toMatchObject({ ok: true });

    const parentCalls = f.server.calls.filter((call) => subagentTask(call) === undefined);
    expect(outputsOf(parentCalls[1]!)).toEqual([{ ok: true, result: "## alpha\n\nFirst line of alpha: ALPHA\n\n## beta\n\nFirst line of beta: BETA" }]);
    expect(toolNames(parentCalls[0]!)).toContain("delegate");

    const subagentCalls = f.server.calls.filter((call) => subagentTask(call) !== undefined);
    expect(subagentCalls).toHaveLength(4);
    for (const call of subagentCalls) {
      expect(JSON.stringify(call.body.input)).not.toContain("Do the task.");
      expect(toolNames(call)).not.toContain("delegate");
      expect(toolNames(call)).not.toContain("ask_user");
      expect(toolNames(call)).toContain("read_file");
    }
    const answered = subagentCalls.filter((call) => outputsOf(call).length);
    expect(answered.map((call) => outputsOf(call)[0]!.result).sort()).toEqual(["     1\tA", "     1\tB"]);

    expect(events).toContainEqual(expect.objectContaining({ type: "item.started", itemId: "d_alpha_beta", title: "Subagents" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "item.output", itemId: "d_alpha_beta", text: "alpha: read_file\n" }));
    expect((end as { usage?: { input: number } }).usage?.input).toBe(60);
  });

  it("asks the person before a subagent writes, in the same chat, and passes a refusal back to that subagent only", async () => {
    const f = await fixture(
      (_call, nth) => nth === 1 ? delegate("writer") : responsesReply.text("The writer was not allowed to write."),
      (_task, _call, nth) => nth === 1
        ? responsesReply.calls({ id: "w1", name: "write_file", args: { path: "new.txt", content: "x" } })
        : responsesReply.text("I was not allowed to write new.txt."),
    );
    const running = f.turn({ approvalMode: "ask" });
    const opened = await f.answerNextRequest("deny");
    expect(opened).toMatchObject({ requestType: "permission", tool: "Subagent \"writer\" · write_file" });
    const { end } = await running;
    expect(end).toMatchObject({ ok: true });
    expect(end).not.toHaveProperty("denials");
    const writerSecond = f.server.calls.filter((call) => subagentTask(call) === "writer")[1]!;
    expect(outputsOf(writerSecond)[0]).toMatchObject({ ok: false, result: expect.stringContaining("Permission denied") });
    expect(() => readFileSync(join(f.folder, "new.txt"))).toThrow();
  });

  it("starts at most eight subagents in one turn", async () => {
    const f = await fixture(
      (_call, nth) => nth <= 3 ? delegate(`a${nth}`, `b${nth}`, `c${nth}`, `d${nth}`) : responsesReply.text("Done."),
      (task) => responsesReply.text(`${task} done`),
    );
    await f.turn();
    const parentCalls = f.server.calls.filter((call) => subagentTask(call) === undefined);
    expect(outputsOf(parentCalls[3]!).at(-1)).toEqual({ ok: false, result: "This turn already ran 8 subagents, the most it may. Do the rest yourself." });
    expect(f.server.calls.filter((call) => subagentTask(call) !== undefined)).toHaveLength(8);
  });

  it("offers no subagents in a guest turn", async () => {
    const f = await fixture(() => responsesReply.text("Hello."), () => responsesReply.text("never"));
    await f.turn({ guestConfined: true });
    expect(toolNames(f.server.calls[0]!)).not.toContain("delegate");
  });

  it("stops every subagent when the person stops the turn", async () => {
    const f = await fixture(
      () => delegate("slow"),
      () => responsesReply.calls({ id: "s1", name: "write_file", args: { path: "late.txt", content: "x" } }),
    );
    const running = f.turn({ approvalMode: "ask" });
    await f.recorder.until((event) => event.type === "request.opened");
    await f.instance.adapter.interruptTurn(f.threadId);
    const { end } = await running;
    expect(end).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(f.recorder.events).toContainEqual(expect.objectContaining({ type: "request.resolved", behavior: "deny", source: "system" }));
    expect(() => readFileSync(join(f.folder, "late.txt"))).toThrow();
  });
});
