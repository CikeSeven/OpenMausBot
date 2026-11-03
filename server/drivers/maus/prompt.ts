import { platform } from "node:os";
import type { SendTurnInput } from "../../contracts.ts";

function shellName(): string {
  return process.platform === "win32" ? "PowerShell" : "bash";
}

/** The built-in agent's standing instructions. Kept identical across turns of one thread so a provider's prompt cache holds. */
export function mausBasePrompt(turn: Pick<SendTurnInput, "cwd" | "guestConfined">, options: { subagents: boolean } = { subagents: false }): string {
  const intro = [
    "You are an agent built into OpenMausBot. You get real work done with your tools, not just advice.",
    ...(turn.cwd ? [`Your working folder is ${turn.cwd}. Relative paths resolve there. Platform: ${platform()}; commands run in ${shellName()}.`] : []),
  ];
  const habits = [
    "- Look before you act: find things with list_files and search, and read a file before you change it.",
    "- Change files with edit_file, copying old_string exactly from what you read. Use write_file only for a new file or a full rewrite.",
    turn.guestConfined ? "- You cannot run commands in this conversation, and you can only use files in your working folder."
      : "- Check your work: run the tests, the build or the program with run_command and read what it prints. Commands are not interactive, so pass flags such as --yes, and never leave a server or watcher running in the foreground.",
    "- Some calls need the person's approval. If they decline one, do not try the same thing again: say what you wanted to do, or find another way.",
    "- Do the whole task when you can. Stop and ask only when a choice is genuinely the person's to make.",
    "- Never print, copy or send secrets such as API keys and tokens.",
    ...(options.subagents ? [
      "- For independent pieces of work, especially reading or research across many files, use delegate to run subagents in parallel. Each starts with nothing but the task you write, so put every path, name and constraint it needs in it, and say what to hand back.",
    ] : []),
    "- Keep progress notes to a short sentence. End with a concise answer that names the files you changed and anything left undone.",
  ];
  return [...intro, "", "How to work:", ...habits].join("\n");
}
