import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export const TEST_INCLUDE = [
  "server/**/*.test.ts",
  "electron/**/*.test.mjs",
  "src/**/*.test.ts",
  "shared/**/*.test.ts",
  "companion/**/*.test.ts",
  "enterprise/**/*.test.ts",
  "connector/**/*.test.ts",
  "scripts/**/*.test.mjs",
  "scripts/**/*.test.ts",
];

export const UNIT_TEST_FILES = JSON.parse(readFileSync(new URL("./unit-tests.json", import.meta.url), "utf8")) as string[];
export const UNIT_INCLUDE = ["src/**/*.test.ts", "shared/**/*.test.ts", ...UNIT_TEST_FILES];
export const UNIT_EXCLUDE = ["**/*.e2e.test.*", "**/*.integration.test.*"];
export const INTEGRATION_INCLUDE = [
  ...TEST_INCLUDE.filter(pattern => !pattern.startsWith("src/") && !pattern.startsWith("shared/")),
  "{src,shared}/**/*.e2e.test.ts",
  "{src,shared}/**/*.integration.test.ts",
];

export function unitWorkers(cpus = availableParallelism(), lanes = Number(process.env.OMB_VITEST_LANE_COUNT ?? 1)): number {
  const count = Number.isSafeInteger(lanes) && lanes > 0 ? lanes : 1;
  return Math.max(1, Math.min(4, Math.floor(cpus / count)));
}
