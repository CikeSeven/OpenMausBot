import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
import { configDefaults } from "vitest/config";
import { hostE2eOnly, portableE2eFiles } from "./host-e2e.ts";
import { TEST_INCLUDE, UNIT_TEST_FILES, unitWorkers } from "./test-suites.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("test suite coverage", () => {
  it("discovers every root test exactly once across the real projects", async () => {
    const ctx = await createVitest("test", { config: path.join(root, "vite.config.ts"), watch: false });
    try {
      const specs = await ctx.globTestSpecifications();
      const files = specs.map(spec => path.relative(root, spec.moduleId).split(path.sep).join("/")).sort();
      const excluded = new Set(hostE2eOnly() ? portableE2eFiles(root, TEST_INCLUDE) : []);
      const expected = [...globSync(TEST_INCLUDE, { cwd: root, exclude: [...configDefaults.exclude] })]
        .map(file => file.split(path.sep).join("/"))
        .filter(file => !excluded.has(file)).sort();
      expect(files).toEqual(expected);
      expect(new Set(files).size).toBe(files.length);
      expect(ctx.projects.map(project => project.name).sort()).toEqual(["integration", "unit"]);
      expect(ctx.projects.every(project => project.config.pool === "forks" && project.config.isolate)).toBe(true);
      expect(ctx.projects.find(project => project.name === "integration")?.config.maxWorkers).toBe(1);
      expect(specs.filter(spec => spec.project.name === "unit").every(spec => !/\.(?:e2e|integration)\.test\./.test(spec.moduleId))).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("keeps each explicitly admitted unit file present and outside the e2e suite", () => {
    const files = new Set(globSync(TEST_INCLUDE, { cwd: root }).map(file => file.split(path.sep).join("/")));
    expect([...new Set(UNIT_TEST_FILES)].sort()).toEqual(UNIT_TEST_FILES);
    for (const file of UNIT_TEST_FILES) {
      expect(files.has(file), file).toBe(true);
      expect(file, file).not.toMatch(/\.(?:e2e|integration)\.test\./);
    }
  });

  it("runs evals through their independent configuration in the full local command", () => {
    const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts;
    expect(scripts["test:all"]).toContain("--project=unit --project=integration");
    expect(scripts["test:all"]).toContain("pnpm test:evals");
    expect(scripts["test:evals"]).toContain("--config evals/vitest.config.ts");
    expect(TEST_INCLUDE.some(pattern => pattern.startsWith("evals/"))).toBe(false);
  });

  it("bounds unit workers by the CPU budget shared with other lanes", () => {
    expect(unitWorkers(24, 1)).toBe(4);
    expect(unitWorkers(2, 1)).toBe(2);
    expect(unitWorkers(16, 10)).toBe(1);
    expect(unitWorkers(2, 8)).toBe(1);
    expect(unitWorkers(8, Number.NaN)).toBe(4);
  });
});
