import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { removeTempDir } from "../../server/testing/cleanup.ts";

// Isolate every file before imports can resolve the person's data or credentials.
const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  OMB_COMPANION_DIR: join(home, ".openmausbot-companion"),
  OMB_BOT_BOX: "off",
});
delete process.env.OMB_DATA_DIR;
delete process.env.HERMES_HOME;
Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

afterAll(() => removeTempDir(home));
