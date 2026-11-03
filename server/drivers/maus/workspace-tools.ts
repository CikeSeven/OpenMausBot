// The built-in agent's own tools in its working folder: read, write and edit files, list and search them, run commands.
// The chat runtime shows and gates every call; `view` decides which ones need a person's yes.
import { existsSync, realpathSync } from "node:fs";
import { glob, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import type { ApprovalMode } from "../../../shared/approval-mode.ts";
import type { SendTurnInput } from "../../contracts.ts";
import { stripWorkspaceCredentialEnv } from "../../credential-env.ts";
import { augmentedPath } from "../../env-path.ts";
import { compileToolSchema, schemaProblems } from "../../mcp-schema-validator.ts";
import { killCliTree, spawnCli } from "../../procs.ts";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult, ChatToolSession } from "../chat-mcp-tools.ts";

const READ_LINES = 2_000;
const READ_BYTES = 256 * 1024;
const LARGEST_FILE = 20 * 1024 * 1024;
const OUTPUT_CHARS = 50_000;
const LISTED_FILES = 500;
const SEARCH_LINES = 200;
const DEFAULT_COMMAND_MS = 120_000;
const LONGEST_COMMAND_MS = 600_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export const WORKSPACE_TOOL_NAMES = ["read_file", "write_file", "edit_file", "list_files", "search", "run_command"] as const;
type ToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

const PATH = { type: "string", description: "A path relative to the working folder, or an absolute path." };
const DEFINITIONS: Record<ToolName, { title: string; description: string; parameters: Record<string, unknown> }> = {
  read_file: {
    title: "Read file",
    description: `Read a text file. Lines come back numbered. At most ${READ_LINES} lines per call: pass offset (1-based line) and limit to read further.`,
    parameters: { type: "object", properties: { path: PATH, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: READ_LINES } }, required: ["path"], additionalProperties: false },
  },
  write_file: {
    title: "Write file",
    description: "Create a file or replace its whole content. Missing parent folders are created. Prefer edit_file to change part of an existing file.",
    parameters: { type: "object", properties: { path: PATH, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
  edit_file: {
    title: "Edit file",
    description: "Replace exact text in a file. old_string must match the file byte for byte, including indentation, and appear exactly once unless replace_all is true. Read the file first.",
    parameters: {
      type: "object",
      properties: { path: PATH, old_string: { type: "string", minLength: 1 }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"], additionalProperties: false,
    },
  },
  list_files: {
    title: "List files",
    description: `List files matching a glob pattern such as "**/*.ts" (default "**/*"), skipping .git and node_modules. At most ${LISTED_FILES} paths.`,
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { ...PATH, description: "The folder to search from; defaults to the working folder." } }, additionalProperties: false },
  },
  search: {
    title: "Search",
    description: `Search file contents with a regular expression. Returns matching lines as path:line:text, at most ${SEARCH_LINES}.`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1 },
        path: { ...PATH, description: "A file or folder to search; defaults to the working folder." },
        glob: { type: "string", description: "Only search files matching this glob, such as \"*.py\"." },
        ignore_case: { type: "boolean" },
      },
      required: ["pattern"], additionalProperties: false,
    },
  },
  run_command: {
    title: "Run command",
    description: `Run a shell command in the working folder and return its output and exit code. Default timeout ${DEFAULT_COMMAND_MS / 1000} s, at most ${LONGEST_COMMAND_MS / 1000} s. Nothing is interactive: never start a command that waits for input.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        workdir: { ...PATH, description: "The folder to run in; defaults to the working folder." },
        timeout_ms: { type: "integer", minimum: 1_000, maximum: LONGEST_COMMAND_MS },
      },
      required: ["command"], additionalProperties: false,
    },
  },
};

const VALIDATORS = new Map<string, ValidateFunction>(
  Object.entries(DEFINITIONS).map(([name, definition]) => [name, compileToolSchema(definition.parameters)]),
);

function isToolName(name: string): name is ToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

/** The deepest existing ancestor, resolved through symlinks, with the rest of the path after it. */
function realTarget(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]/, ""));
    existing = parent;
  }
  try { return resolve(realpathSync(existing), ...rest); } catch { return path; }
}

function within(root: string, path: string): boolean {
  const between = relative(root, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

function bounded(text: string): string {
  if (text.length <= OUTPUT_CHARS) return text;
  const half = OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n\n[… ${text.length - OUTPUT_CHARS} characters left out …]\n\n${text.slice(-half)}`;
}

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}…`;
}

function diffPreview(before: string, after: string): string {
  const lines = (text: string, mark: string) => text.split("\n").map((line) => `${mark} ${line}`).join("\n");
  return clip(`${lines(before, "-")}\n${lines(after, "+")}`, 4_000);
}

function shellFor(command: string): { cli: string; args: string[] } {
  if (process.platform === "win32") return { cli: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  return { cli: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c", command] };
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  return env;
}

interface Ran { output: string; code: number | null; timedOut: boolean }

async function runProcess(cli: string, args: string[], options: {
  cwd: string; timeoutMs: number; signal: AbortSignal; onOutput?: (text: string) => void;
}): Promise<Ran> {
  options.signal.throwIfAborted();
  const child = spawnCli(cli, args, { cwd: options.cwd, env: commandEnvironment(), stdio: ["ignore", "pipe", "pipe"] }, "bot");
  let head = "";
  let tail = "";
  let dropped = 0;
  const take = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    options.onOutput?.(text);
    if (head.length < OUTPUT_CHARS / 2) {
      const room = OUTPUT_CHARS / 2 - head.length;
      head += text.slice(0, room);
      tail += text.slice(room);
    } else tail += text;
    if (tail.length > OUTPUT_CHARS / 2) {
      dropped += tail.length - OUTPUT_CHARS / 2;
      tail = tail.slice(-OUTPUT_CHARS / 2);
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  let timedOut = false;
  const stop = () => { void killCliTree(child); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("close", (exitCode) => done(exitCode));
    });
    options.signal.throwIfAborted();
    const output = dropped ? `${head}\n\n[… ${dropped} characters left out …]\n\n${tail}` : head + tail;
    return { output, code, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
  }
}

function numbered(text: string, offset: number, limit: number): { text: string; shown: number; total: number } {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const start = offset - 1;
  const chosen: string[] = [];
  let bytes = 0;
  for (let index = start; index < lines.length && chosen.length < limit; index++) {
    const line = `${String(index + 1).padStart(6)}\t${lines[index]}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > READ_BYTES && chosen.length) break;
    chosen.push(line);
  }
  return { text: chosen.join("\n"), shown: chosen.length, total: lines.length };
}

async function searchWithRipgrep(args: { pattern: string; target: string; glob?: string; ignoreCase?: boolean; cwd: string; signal: AbortSignal }): Promise<string | null> {
  const argv = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "400", ...(args.ignoreCase ? ["-i"] : []),
    ...(args.glob ? ["--glob", args.glob] : []), "-e", args.pattern, "--", args.target];
  try {
    const ran = await runProcess("rg", argv, { cwd: args.cwd, timeoutMs: 60_000, signal: args.signal });
    if (ran.code !== 0 && ran.code !== 1) return ran.code === 2 && ran.output.includes("regex parse error") ? `Invalid regular expression: ${clip(ran.output, 500)}` : null;
    const lines = ran.output.split("\n").filter(Boolean);
    return lines.length ? lines.slice(0, SEARCH_LINES).join("\n") + (lines.length > SEARCH_LINES ? `\n[${lines.length - SEARCH_LINES} more matching lines left out]` : "") : "No matches.";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The search used where ripgrep is not installed. */
export async function searchInProcess(args: { pattern: string; target: string; glob?: string; ignoreCase?: boolean; root: string; signal: AbortSignal }): Promise<string> {
  let expression: RegExp;
  try { expression = new RegExp(args.pattern, args.ignoreCase ? "i" : ""); }
  catch (error) { return `Invalid regular expression: ${(error as Error).message}`; }
  const found: string[] = [];
  const info = await stat(args.target);
  const files = info.isFile() ? [args.target] : [];
  if (!info.isFile()) {
    for await (const entry of glob(args.glob ? `**/${args.glob}` : "**/*", { cwd: args.target, exclude: (name) => SKIPPED_DIRECTORIES.has(String(name).split(/[\\/]/).at(-1) ?? "") })) {
      files.push(resolve(args.target, entry));
      if (files.length > 20_000) break;
    }
  }
  for (const file of files) {
    args.signal.throwIfAborted();
    let text: string;
    try {
      const size = (await stat(file)).size;
      if (size > 2 * 1024 * 1024) continue;
      const bytes = await readFile(file);
      if (bytes.subarray(0, 8_192).includes(0)) continue;
      text = bytes.toString("utf8");
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!expression.test(line)) continue;
      found.push(`${relative(args.root, file) || file}:${index + 1}:${clip(line, 400)}`);
      if (found.length > SEARCH_LINES) return `${found.slice(0, SEARCH_LINES).join("\n")}\n[more matching lines left out]`;
    }
  }
  return found.length ? found.join("\n") : "No matches.";
}

/** The workspace tools for one turn, or undefined when the turn has no folder to work in. */
export function workspaceTools(turn: SendTurnInput): ChatToolSession | undefined {
  if (!turn.cwd || !isAbsolute(turn.cwd)) return undefined;
  const root = realTarget(resolve(turn.cwd));
  const guest = turn.guestConfined === true;
  const names = WORKSPACE_TOOL_NAMES.filter((name) => !(guest && name === "run_command"));
  const definitions: ChatToolDefinition[] = names.map((name) => ({
    type: "function",
    function: { name, description: DEFINITIONS[name].description, parameters: DEFINITIONS[name].parameters },
  }));
  const mode = (): ApprovalMode => turn.approvalModeNow?.() ?? turn.approvalMode ?? "ask";
  const place = (raw: unknown): { path: string; inside: boolean } => {
    const path = realTarget(resolve(root, typeof raw === "string" && raw ? raw : "."));
    return { path, inside: within(root, path) };
  };
  const shown = (path: string) => within(root, path) ? relative(root, path) || "." : path;
  const writeGrant = JSON.stringify(["mausAgent", "write", root]);

  const validate = (name: string, args: unknown) => {
    if (!isToolName(name) || !names.includes(name)) throw new Error("The requested tool was not advertised for this turn");
    const check = VALIDATORS.get(name)!;
    if (!check(args)) throw new Error(`Invalid arguments: ${schemaProblems(check.errors).join("; ")}`);
    const target = name === "run_command" ? (args as { workdir?: unknown }).workdir : (args as { path?: unknown }).path;
    if (guest && !place(target).inside) throw new Error(turn.confinedWhy ?? "This conversation can only use files in its own folder.");
  };

  const view = (name: string, args: Record<string, unknown>): ChatToolCallView => {
    const title = isToolName(name) ? DEFINITIONS[name].title : name;
    const level = mode();
    switch (name) {
      case "read_file":
      case "list_files":
      case "search": {
        const { path, inside } = place(args.path);
        return { title, input: { ...args, path: shown(path) }, ask: !inside };
      }
      case "write_file":
      case "edit_file": {
        const { path, inside } = place(args.path);
        const edits = inside && (level === "edits" || level === "auto");
        const input = name === "write_file"
          ? { path: shown(path), content: clip(String(args.content ?? ""), 2_000) }
          : { path: shown(path), change: diffPreview(String(args.old_string ?? ""), String(args.new_string ?? "")) };
        return { title, input, ask: !edits, ...(inside ? { grant: writeGrant } : {}) };
      }
      case "run_command": {
        const workdir = place(args.workdir).path;
        return {
          title,
          input: { command: String(args.command ?? ""), ...(args.workdir !== undefined ? { workdir: shown(workdir) } : {}) },
          ask: true,
          grant: JSON.stringify(["mausAgent", "command", String(args.command ?? ""), workdir]),
        };
      }
      default:
        return { title, input: args, ask: true };
    }
  };

  const execute = async (name: string, args: Record<string, unknown>, signal: AbortSignal, onOutput?: (text: string) => void): Promise<ChatToolResult> => {
    validate(name, args);
    signal.throwIfAborted();
    switch (name as ToolName) {
      case "read_file": {
        const { path } = place(args.path);
        const info = await stat(path);
        if (info.isDirectory()) return { ok: false, text: `${shown(path)} is a folder. Use list_files to see what is in it.` };
        if (info.size > LARGEST_FILE) return { ok: false, text: `${shown(path)} is ${info.size} bytes, too large to read. Use search, or run_command with head or tail.` };
        const bytes = await readFile(path);
        if (bytes.subarray(0, 8_192).includes(0)) return { ok: false, text: `${shown(path)} is a binary file.` };
        const offset = typeof args.offset === "number" ? args.offset : 1;
        const limit = typeof args.limit === "number" ? args.limit : READ_LINES;
        const read = numbered(bytes.toString("utf8"), offset, limit);
        if (!read.total) return { ok: true, text: `${shown(path)} is empty.` };
        if (!read.shown) return { ok: false, text: `${shown(path)} has ${read.total} lines; offset ${offset} is past the end.` };
        const last = offset + read.shown - 1;
        return { ok: true, text: last < read.total ? `${read.text}\n\n[Lines ${offset}–${last} of ${read.total}. Pass offset ${last + 1} to read on.]` : read.text };
      }
      case "write_file": {
        const { path } = place(args.path);
        await mkdir(dirname(path), { recursive: true });
        const content = String(args.content);
        await writeFile(path, content);
        return { ok: true, text: `Wrote ${Buffer.byteLength(content)} bytes to ${shown(path)}.` };
      }
      case "edit_file": {
        const { path } = place(args.path);
        const before = await readFile(path, "utf8");
        const oldString = String(args.old_string);
        const count = before.split(oldString).length - 1;
        if (count === 0) return { ok: false, text: `old_string was not found in ${shown(path)}. Read the file again and copy the text exactly.` };
        if (count > 1 && args.replace_all !== true) {
          return { ok: false, text: `old_string appears ${count} times in ${shown(path)}. Include more surrounding lines so it is unique, or set replace_all.` };
        }
        const after = args.replace_all === true ? before.split(oldString).join(String(args.new_string)) : before.replace(oldString, () => String(args.new_string));
        await writeFile(path, after);
        return { ok: true, text: `Edited ${shown(path)} (${args.replace_all === true ? count : 1} replacement${count > 1 && args.replace_all === true ? "s" : ""}).` };
      }
      case "list_files": {
        const { path } = place(args.path);
        const pattern = typeof args.pattern === "string" && args.pattern ? args.pattern : "**/*";
        const found: string[] = [];
        let more = false;
        for await (const entry of glob(pattern, { cwd: path, exclude: (name) => SKIPPED_DIRECTORIES.has(String(name).split(/[\\/]/).at(-1) ?? "") })) {
          signal.throwIfAborted();
          if (found.length >= LISTED_FILES) { more = true; break; }
          found.push(shown(resolve(path, entry)));
        }
        found.sort();
        if (!found.length) return { ok: true, text: "No files match." };
        return { ok: true, text: `${found.join("\n")}${more ? `\n[More than ${LISTED_FILES} paths; narrow the pattern.]` : ""}` };
      }
      case "search": {
        const { path } = place(args.path);
        const query = { pattern: String(args.pattern), target: path, ...(typeof args.glob === "string" ? { glob: args.glob } : {}), ignoreCase: args.ignore_case === true, signal };
        const text = await searchWithRipgrep({ ...query, cwd: root }) ?? await searchInProcess({ ...query, root });
        return { ok: !text.startsWith("Invalid regular expression"), text: bounded(text) };
      }
      case "run_command": {
        const workdir = place(args.workdir).path;
        const shell = shellFor(String(args.command));
        const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_COMMAND_MS;
        const ran = await runProcess(shell.cli, shell.args, { cwd: workdir, timeoutMs, signal, ...(onOutput ? { onOutput } : {}) });
        const ending = ran.timedOut ? `[Timed out after ${Math.round(timeoutMs / 1000)} s; the command was stopped.]` : `[Exit code ${ran.code ?? "unknown"}]`;
        return { ok: !ran.timedOut && ran.code === 0, text: `${ran.output.trimEnd() || "(no output)"}\n${ending}` };
      }
    }
  };

  return {
    definitions,
    skipped: [],
    trimmed: [],
    budget: { limit: definitions.length, listed: definitions.length, servers: [] },
    validate,
    view,
    execute,
    close: async () => {},
  };
}
