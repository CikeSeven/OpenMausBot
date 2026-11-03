import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const usage = "usage: pnpm test:file <path.test.ts> [more test files] [Vitest options]";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}
const files = [];
while (args[0] && !args[0].startsWith("-")) {
  const file = args.shift();
  try {
    if (!/\.test\.[cm]?[jt]sx?$/i.test(file) || !statSync(file).isFile()) throw new Error("not a test file");
    files.push(realpathSync(file));
  } catch {
    console.error(`${usage}\nExpected an existing test file: ${file}`);
    process.exit(2);
  }
}
if (!files.length) {
  console.error(usage);
  process.exit(2);
}

const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url)), "run", ...files, ...args], {
  cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1);
