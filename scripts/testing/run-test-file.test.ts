import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hostTimeout } from "../../server/testing/host-timeout.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const entry = fileURLToPath(new URL("./run-test-file.mjs", import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: "utf8", timeout: hostTimeout(10_000) });

it.each([[], ["shared"], ["package.json"], ["--project=unit"]])("refuses %j instead of starting a broad suite", (...args) => {
  const result = run(args);
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("usage: pnpm test:file");
  expect(result.stdout).not.toContain("RUN");
});

it("runs complete file paths from both projects and preserves Vitest options", () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-test-file-"));
  try {
    const report = join(scratch, "report.json");
    const result = run(["shared/line-diff.test.ts", "scripts/testing/fixture-clock.test.ts", "--reporter=json", `--outputFile.json=${report}`]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const data = JSON.parse(readFileSync(report, "utf8"));
    expect(data.numPassedTests).toBe(5);
    expect(data.testResults.map((file: { name: string }) => relative(root, file.name).split(sep).join("/")).sort())
      .toEqual(["scripts/testing/fixture-clock.test.ts", "shared/line-diff.test.ts"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
