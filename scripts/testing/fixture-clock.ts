import { mock } from "node:test";
import { performance } from "node:perf_hooks";

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const offset = Number(new URL(import.meta.url).searchParams.get("offset") ?? 0);
if (!process.send || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Fixture clock needs an IPC child and a valid offset");

mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() + offset });
let previous = performance.now();
const followWallClock = () => {
  const elapsed = Math.floor(performance.now() - previous);
  previous += elapsed;
  mock.timers.tick(elapsed);
};
const ticking = nativeSetInterval(followWallClock, 20);
ticking.unref();
process.channel?.unref();

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const command = message as { type?: string; id?: string; ms?: number };
  if (command.type !== "omb:fixture-clock:advance" || typeof command.id !== "string") return;
  if (typeof command.ms !== "number" || !Number.isSafeInteger(command.ms) || command.ms < 0) return;
  followWallClock();
  mock.timers.tick(command.ms);
  setImmediate(() => process.send?.({ type: "omb:fixture-clock:advanced", id: command.id }));
});

process.once("disconnect", () => {
  nativeClearInterval(ticking);
  mock.timers.reset();
  if (process.listenerCount("SIGTERM")) process.emit("SIGTERM");
  else process.exit(0);
});
