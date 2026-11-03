import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../../testing/cleanup.ts";
import { searchInProcess, workspaceTools } from "./workspace-tools.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

function folder(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "omb-maus-tools-"));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const run = (root: string, name: string, args: Record<string, unknown>) =>
  workspaceTools({ threadId: "t", text: "", cwd: root })!.execute(name, args, new AbortController().signal);

describe("the built-in agent's workspace tools", () => {
  it("offers nothing without an absolute working folder", () => {
    expect(workspaceTools({ threadId: "t", text: "" })).toBeUndefined();
    expect(workspaceTools({ threadId: "t", text: "", cwd: "relative/path" })).toBeUndefined();
  });

  it("reads a window of a long file and says where to continue", async () => {
    const root = folder({ "long.txt": Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") });
    const result = await run(root, "read_file", { path: "long.txt", offset: 3, limit: 2 });
    expect(result).toEqual({ ok: true, text: "     3\tline 3\n     4\tline 4\n\n[Lines 3–4 of 10. Pass offset 5 to read on.]" });
  });

  it("refuses a binary file and a folder", async () => {
    const root = folder({ "image.bin": "PNG\0\0data", "dir/file.txt": "x" });
    expect(await run(root, "read_file", { path: "image.bin" })).toMatchObject({ ok: false, text: "image.bin is a binary file." });
    expect(await run(root, "read_file", { path: "dir" })).toMatchObject({ ok: false });
  });

  it("edits only a unique match unless told to replace every one", async () => {
    const root = folder({ "a.txt": "x = 1\nx = 1\n" });
    expect(await run(root, "edit_file", { path: "a.txt", old_string: "x = 1", new_string: "x = 2" })).toMatchObject({ ok: false });
    expect(await run(root, "edit_file", { path: "a.txt", old_string: "y", new_string: "z" })).toMatchObject({ ok: false });
    expect(await run(root, "edit_file", { path: "a.txt", old_string: "x = 1", new_string: "x = $&", replace_all: true }))
      .toEqual({ ok: true, text: "Edited a.txt (2 replacements)." });
    expect(await run(root, "read_file", { path: "a.txt" })).toMatchObject({ text: "     1\tx = $&\n     2\tx = $&" });
  });

  it("lists files without .git or node_modules", async () => {
    const root = folder({ "src/a.ts": "", "src/b.js": "", "node_modules/m/index.js": "", ".git/HEAD": "" });
    expect((await run(root, "list_files", {})).text.split("\n")).toEqual(["src", "src/a.ts", "src/b.js"]);
    expect((await run(root, "list_files", { pattern: "**/*.ts" })).text).toBe("src/a.ts");
  });

  it("searches file contents and reports a bad expression", async () => {
    const root = folder({ "src/a.ts": "const answer = 42;\n", "src/b.ts": "nothing here\n" });
    expect((await run(root, "search", { pattern: "answer\\s*=" })).text).toMatch(/src\/a\.ts:1:const answer = 42;/);
    expect(await run(root, "search", { pattern: "zzz" })).toEqual({ ok: true, text: "No matches." });
    expect(await run(root, "search", { pattern: "(" })).toMatchObject({ ok: false });
  });

  it("searches without ripgrep too, skipping binary files and node_modules", async () => {
    const root = folder({ "src/a.ts": "const answer = 42;\n", "data.bin": "answer\0", "node_modules/m.js": "answer" });
    const search = (pattern: string, glob?: string) => searchInProcess({ pattern, target: root, root, signal: new AbortController().signal, ...(glob ? { glob } : {}) });
    expect(await search("ANSWER")).toBe("No matches.");
    expect(await search("answer\\s*=")).toBe("src/a.ts:1:const answer = 42;");
    expect(await search("answer", "*.js")).toBe("No matches.");
    expect(await search("(")).toMatch(/^Invalid regular expression/);
  });

  it("treats a symlink that leaves the folder as outside it", () => {
    const outside = folder({ "secret.txt": "s" });
    const root = folder();
    symlinkSync(outside, join(root, "link"));
    const tools = workspaceTools({ threadId: "t", text: "", cwd: root, approvalMode: "edits" })!;
    expect(tools.view("read_file", { path: "link/secret.txt" }).ask).toBe(true);
    expect(tools.view("read_file", { path: "inside.txt" }).ask).toBe(false);
    expect(tools.view("write_file", { path: "link/new.txt", content: "" })).toMatchObject({ ask: true });
    expect(tools.view("write_file", { path: "new.txt", content: "" })).toMatchObject({ ask: false });
  });

  it("reads the approval level at each call, so a change mid-turn applies to the next one", () => {
    let level: "ask" | "edits" = "ask";
    const tools = workspaceTools({ threadId: "t", text: "", cwd: folder(), approvalModeNow: () => level })!;
    expect(tools.view("edit_file", { path: "a", old_string: "x", new_string: "y" }).ask).toBe(true);
    level = "edits";
    expect(tools.view("edit_file", { path: "a", old_string: "x", new_string: "y" }).ask).toBe(false);
  });

  it.skipIf(process.platform === "win32")("stops a command at its timeout", async () => {
    const root = folder();
    const result = await run(root, "run_command", { command: "sleep 30", timeout_ms: 1_000 });
    expect(result).toEqual({ ok: false, text: "(no output)\n[Timed out after 1 s; the command was stopped.]" });
  });
});
