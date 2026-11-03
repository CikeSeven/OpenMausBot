// Ports for suites that boot real servers: probe first, so two suites at once never lose an unchecked bind.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";

const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

const claims = new Set<string>();
const claimsDir = join(tmpdir(), "openmausbot-test-port-claims");

function releaseClaims(files: Iterable<string>): void {
  for (const file of files) {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) unlinkSync(file);
    } catch {}
    claims.delete(file);
  }
}

process.once("exit", () => releaseClaims(claims));

function claimPort(port: number): string | null {
  const file = join(claimsDir, `${port}.json`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, port })); }
      catch (error) { unlinkSync(file); throw error; }
      finally { closeSync(fd); }
      claims.add(file);
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.port !== port) return null;
        try { process.kill(owner.pid, 0); return null; }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") return null; }
        unlinkSync(file);
      } catch { return null; }
    }
  }
  return null;
}

// The child binds after probing; process-owned claims cover that gap between test workers.
export async function freePortBlock(offsets: number[], from = 19_600, span = 3_000): Promise<number> {
  mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = from + Math.floor(Math.random() * span);
    const reserved: string[] = [];
    for (const offset of new Set(offsets)) {
      const claimed = claimPort(base + offset);
      if (!claimed) break;
      reserved.push(claimed);
    }
    if (reserved.length !== new Set(offsets).size) { releaseClaims(reserved); continue; }
    const checks = await Promise.all(offsets.map((offset) => isFree(base + offset))).catch(error => {
      releaseClaims(reserved);
      throw error;
    });
    if (checks.every(Boolean)) return base;
    releaseClaims(reserved);
  }
  throw new Error(`no free port block for offsets ${offsets.join(",")} in ${from}..${from + span}`);
}

/** The lowest port the OS hands out itself: Linux's ip_local_port_range, else IANA's dynamic range (macOS, Windows). */
function ephemeralFloor(): number {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
  } catch {
    return 49_152;
  }
}

/** A pre-registered sign-in app returns to one loopback port derived from the URL (mcpOAuthRedirectUri).
 * On Linux the top of 20000-39999 is the ephemeral range, held by client connections and TIME_WAIT, so
 * a query moves the derived port below it. */
export async function withFreeSignInPort(url: string): Promise<string> {
  const floor = ephemeralFloor();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = new URL(url);
    candidate.searchParams.set("app", String(attempt));
    const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
    if (port < floor && await isFree(port)) return candidate.toString();
  }
  throw new Error(`no free sign-in redirect port below ${floor} for ${url}`);
}
