import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";

it("advances an IPC child's timers while real HTTP and ordinary timers keep working", async () => {
  const program = `
    import { createServer } from "node:http";
    let short = false, long = false;
    setTimeout(() => { short = true; }, 100);
    setTimeout(() => { long = true; }, 60_000);
    const server = createServer((req, res) => res.end(JSON.stringify({ short, long, now: Date.now() })));
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  `;
  const child = spawn(process.execPath, ["--import", new URL("./fixture-clock.ts", import.meta.url).href, "--input-type=module", "-e", program], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  try {
    const [{ port }] = await once(child, "message") as [{ port: number }];
    const read = async () => (await (await fetch(`http://127.0.0.1:${port}`)).json()) as { short: boolean; long: boolean; now: number };
    await expect.poll(async () => (await read()).short, { timeout: hostTimeout(2_000) }).toBe(true);
    const before = await read();
    expect(before.long).toBe(false);
    const advanced = once(child, "message");
    child.send({ type: "omb:fixture-clock:advance", id: "fixture", ms: 90_000 });
    expect((await advanced)[0]).toEqual({ type: "omb:fixture-clock:advanced", id: "fixture" });
    const after = await read();
    expect(after.long, stderr).toBe(true);
    expect(after.now - before.now).toBeGreaterThanOrEqual(90_000);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
});
