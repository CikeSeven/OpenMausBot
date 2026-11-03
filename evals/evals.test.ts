import { describe, expect, it } from "vitest";
import { runScenario } from "./runners/run-scenario.ts";
import { loadScenarios } from "./runners/run-evals.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The offline tier-1 gate: every scenario runs against a freshly booted
// real server with the deterministic scripted engine. These are the
// behavior pins the release report diffs.
describe("behavior evals", () => {
  const scenarios = loadScenarios();
  it("loads at least the founding scenario set", () => {
    expect(scenarios.map((scenario) => scenario.id)).toContain("dispatch-supersede");
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it.each(scenarios)("$id pins its behavior", async (scenario) => {
    const result = await runScenario(scenario);
    if (result.pass) return;
    const directory = fileURLToPath(new URL("../.omb-scratch/eval-failures/", import.meta.url));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${scenario.id}.json`), JSON.stringify(result, null, 2));
    const failures = result.assertions
      .filter((assertion) => !assertion.pass)
      .map((assertion) => assertion.assertion.kind + ": " + assertion.detail)
      .join("\n");
    throw new Error(
      result.id + " failed" + (result.error === undefined ? "" : ": " + result.error) + "\n" + failures,
    );
  }, 180_000);

  it("keeps the evidence and original error when a later scenario step fails", async () => {
    const base = scenarios.find(scenario => scenario.id === "dispatch-supersede")!;
    const result = await runScenario({
      ...base,
      assertions: [],
      steps: [
        { kind: "send", bot: "chief", text: "Please have Engineering build the CSV export." },
        { kind: "waitForTurns", bot: "chief", count: 1, timeoutMs: 20_000 },
        { kind: "createRoutine", routine: "invalid", bot: "missing-bot", prompt: "fixture" },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.error).toContain("unknown bot reference missing-bot");
    expect(result.steps.at(-1)?.ok).toBe(false);
    expect(result.evidence.sends).toHaveLength(1);
    expect(result.evidence.turns.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
