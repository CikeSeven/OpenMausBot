import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { waitForExit } from "./cleanup.ts";

const children: ChildProcess[] = [];
afterEach(async () => {
  const active = children.splice(0);
  for (const child of active) if (child.connected) child.send("stop", () => {});
  await Promise.all(active.map(child => waitForExit(child)));
});

function claim(from: number, span: number): Promise<{ child: ChildProcess; port: number }> {
  const source = `
    import { freePortBlock } from ${JSON.stringify(new URL("./ports.ts", import.meta.url).href)};
    try {
      const port = await freePortBlock([0], ${from}, ${span});
      process.on("message", () => process.exit(0));
      process.send({ port });
    } catch (error) { process.send({ error: error.message }, () => process.exit(1)); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Port claimant exited ${code}: ${stderr}`)));
    child.once("message", message => {
      const result = message as { port?: number; error?: string };
      if (result.error) reject(new Error(result.error));
      else resolve({ child, port: result.port! });
    });
  });
}

it("does not give another worker an unbound port that is already claimed", async () => {
  const first = await claim(25_000, 3_000);
  await expect(claim(first.port, 1)).rejects.toThrow("no free port block");
});

it("reclaims a port after its worker crashes without cleanup", async () => {
  const first = await claim(25_000, 3_000);
  await waitForExit(first.child, { signal: "SIGKILL" });
  const next = await claim(first.port, 1);
  expect(next.port).toBe(first.port);
});
