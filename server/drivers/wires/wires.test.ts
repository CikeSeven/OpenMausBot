// The built-in agent's Anthropic and Gemini wires, end to end through the chat runtime against a fake server that
// streams each API's documented event shapes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import { anthropicReply, geminiReply, type FakeModelCall, type FakeReply } from "../../testing/fake-model-server.ts";
import { mausFixture, type MausFixture } from "../../testing/maus-fixture.ts";
import type { MausWire } from "../../../shared/maus-agent.ts";

const fixtures: MausFixture[] = [];
beforeAll(() => ensureDirs());
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

async function fixture(wire: MausWire, model: string, script: (call: FakeModelCall, nth: number) => FakeReply, models?: unknown) {
  const made = await mausFixture({ wire, model, script, ...(models ? { models } : {}) });
  fixtures.push(made);
  return made;
}

const WRITE = { name: "write_file", args: { path: "out.txt", content: "made" } };

describe("the Anthropic Messages wire", () => {
  const MODEL = "claude-opus-5-5";

  it("runs a tool round with adaptive thinking and hands the signed thinking back untouched", async () => {
    const f = await fixture("anthropic", MODEL, (_call, nth) => nth === 1
      ? anthropicReply.calls("Plan: write the file.", { id: "toolu_1", ...WRITE })
      : anthropicReply.text("Wrote out.txt."));
    const { end, events } = await f.turn({ effort: "high" });
    expect(end).toMatchObject({ ok: true });
    expect(readFileSync(join(f.folder, "out.txt"), "utf8")).toBe("made");

    const [first, second] = f.server.calls;
    expect(first!.path).toBe("/v1/messages");
    expect(first!.headers).toMatchObject({ "x-api-key": "fixture-key-81c2", "anthropic-version": "2023-06-01" });
    expect(first!.body).toMatchObject({
      model: MODEL, stream: true,
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
      system: [{ type: "text", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "Do the task.", cache_control: { type: "ephemeral" } }] }],
    });
    expect(first!.body).not.toHaveProperty("temperature");
    const tools = first!.body.tools as Array<Record<string, unknown>>;
    expect(tools.find((tool) => tool.name === "write_file")).toMatchObject({ input_schema: { type: "object" } });
    expect(tools.at(-1)).toMatchObject({ cache_control: { type: "ephemeral" } });

    expect(second!.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Do the task." }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Plan: write the file.", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "out.txt", content: "made" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Wrote 4 bytes to out.txt.", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "Plan: write the file." }));
  });

  it("sends no thinking settings when no effort is chosen, and asks for the model's own output limit", async () => {
    const f = await fixture("anthropic", MODEL, () => anthropicReply.text("Hi."),
      { data: [{ id: MODEL, display_name: "Claude Opus 5.5", max_tokens: 40_000, max_input_tokens: 1_000_000 }] });
    await f.instance.refreshModels?.();
    expect(f.instance.models.options).toEqual([{ id: MODEL, label: "Claude Opus 5.5", custom: true, contextWindow: 1_000_000 }]);
    await f.turn();
    expect(f.server.calls[0]!.body).toMatchObject({ max_tokens: 40_000 });
    expect(f.server.calls[0]!.body).not.toHaveProperty("thinking");
    expect(f.server.calls[0]!.body).not.toHaveProperty("output_config");
  });

  it("marks a failed call's result as an error", async () => {
    const f = await fixture("anthropic", MODEL, (_call, nth) => nth === 1
      ? anthropicReply.calls(undefined, { id: "toolu_1", name: "read_file", args: { path: "missing.txt" } })
      : anthropicReply.text("That file does not exist."));
    await f.turn();
    const results = (f.server.calls[1]!.body.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1)!.content;
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: true });
  });

  it("ends the turn with the model's own words when it declines", async () => {
    const f = await fixture("anthropic", MODEL, () => ({ named: true, sse: [
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "Not able to help with that." } } },
      { type: "message_stop" },
    ] }));
    const { end, events } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("Not able to help with that.") }));
  });
});

describe("the Gemini wire", () => {
  it("runs a tool round, keeps the thought signature, and answers the call by name", async () => {
    const MODEL = "gemini-3-pro";
    const f = await fixture("gemini", MODEL, (_call, nth) => nth === 1
      ? geminiReply.calls({ ...WRITE, signature: "c2lnbmF0dXJl" })
      : geminiReply.text("Wrote out.txt."), { models: [] });
    const { end } = await f.turn({ effort: "high" });
    expect(end).toMatchObject({ ok: true });
    expect(readFileSync(join(f.folder, "out.txt"), "utf8")).toBe("made");

    const [first, second] = f.server.calls;
    expect(first!.path).toBe(`/v1/models/${MODEL}:streamGenerateContent?alt=sse`);
    expect(first!.headers["x-goog-api-key"]).toBe("fixture-key-81c2");
    expect(first!.body.systemInstruction.parts[0].text).toContain("agent built into OpenMausBot");
    expect(first!.body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } });
    const declarations = first!.body.tools[0].functionDeclarations as Array<Record<string, unknown>>;
    expect(declarations.find((tool) => tool.name === "write_file")).toMatchObject({ parametersJsonSchema: { type: "object" } });

    expect(second!.body.contents).toEqual([
      { role: "user", parts: [{ text: "Do the task." }] },
      { role: "model", parts: [{ functionCall: { name: "write_file", args: { path: "out.txt", content: "made" } }, thoughtSignature: "c2lnbmF0dXJl" }] },
      { role: "user", parts: [{ functionResponse: { name: "write_file", response: { output: "Wrote 4 bytes to out.txt." } } }] },
    ]);
  });

  it("gives a Gemini 2 model a thinking budget, and lists only models that generate content", async () => {
    const MODEL = "gemini-2.5-flash";
    const f = await fixture("gemini", MODEL, () => geminiReply.text("Hello there."), { models: [
      { name: `models/${MODEL}`, displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1_048_576 },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ] });
    const { events } = await f.turn({ effort: "low" });
    expect(f.server.calls[0]!.body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true, thinkingBudget: 1_024 } });
    expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "Hello there." }));
    await f.instance.refreshModels?.();
    expect(f.instance.models.options).toEqual([{ id: MODEL, label: "Gemini 2.5 Flash", custom: true, contextWindow: 1_048_576 }]);
  });

  it("names a safety stop instead of answering with nothing", async () => {
    const f = await fixture("gemini", "gemini-3-pro", () => ({ sse: [{ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] }] }), { models: [] });
    const { end, events } = await f.turn();
    expect(end).toMatchObject({ ok: false });
    expect(events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("SAFETY") }));
  });
});
