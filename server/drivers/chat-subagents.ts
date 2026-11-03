// Subagents for the chat runtime: the same agent run again on one piece of the work, with the turn's tools, approval
// cards and stop button, but none of the conversation. Each hands back only its answer, so the reading it did stays out
// of the parent's context. A subagent cannot ask the person a question or start subagents of its own.
import type { ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";
import type { Completion, OpenAIChatMessage } from "./openai-chat.ts";
import { object } from "./openai-chat-protocol.ts";

export const DELEGATE_TOOL = "delegate";
const TASKS_PER_CALL = 4;
const ANSWER_CHARS = 8_000;

export const DELEGATE_TOOL_DEFINITION: ChatToolDefinition = {
  type: "function",
  function: {
    name: DELEGATE_TOOL,
    description: `Run up to ${TASKS_PER_CALL} subagents in parallel, each on one self-contained task, and get back each one's answer. `
      + "A subagent has your tools but none of this conversation: write every path, name and constraint it needs into its prompt, "
      + "and say exactly what it should hand back. Use it for independent work, especially reading or searching across many files.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array", minItems: 1, maxItems: TASKS_PER_CALL,
          items: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 1, maxLength: 80, description: "A few words naming the task." },
              prompt: { type: "string", minLength: 1, description: "The whole task, and what to hand back." },
            },
            required: ["title", "prompt"], additionalProperties: false,
          },
        },
      },
      required: ["tasks"], additionalProperties: false,
    },
  },
};

export interface SubagentTask { title: string; prompt: string }

/** Runs each job only after the one before it settles. */
export function serialized(): <T>(run: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (run) => {
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
}

export function subagentTasks(args: Record<string, unknown>): SubagentTask[] | null {
  if (!Array.isArray(args.tasks) || !args.tasks.length || args.tasks.length > TASKS_PER_CALL) return null;
  const tasks = args.tasks.map((raw) => {
    const task = object(raw);
    return typeof task?.title === "string" && task.title.trim() && typeof task.prompt === "string" && task.prompt.trim()
      ? { title: task.title.trim().slice(0, 80), prompt: task.prompt } : null;
  });
  return tasks.every((task): task is SubagentTask => task !== null) ? tasks : null;
}

export interface SubagentLimits {
  /** Subagents one turn may start in all. */
  perTurn: number;
  /** Subagents running at once. */
  concurrent: number;
  /** Model rounds one subagent may take. */
  rounds: number;
}

export interface SubagentContext {
  system: string;
  definitions: ChatToolDefinition[];
  signal: AbortSignal;
  limits: SubagentLimits;
  /** One model round on a subagent's own messages. */
  complete(messages: OpenAIChatMessage[]): Promise<Completion>;
  /** The assistant message the runtime keeps for a completion, with the provider's own items for replay. */
  reply(completion: Completion, content: string | null): OpenAIChatMessage;
  /** Shows, gates and runs one call as the turn's own calls are. */
  call(name: string, args: Record<string, unknown>, label: string): Promise<ChatToolResult>;
  progress(line: string): void;
}

function framing(task: SubagentTask): string {
  return [
    "You are a subagent: the same agent, run again on one piece of a larger task. You see none of the conversation; everything you know is below.",
    "Do the task with your tools, then reply with only what it asks you to hand back. Nobody can answer questions here and you cannot start subagents: decide for yourself and state any assumption you made.",
    "",
    `Task: ${task.title}`,
    "",
    task.prompt,
  ].join("\n");
}

async function runOne(task: SubagentTask, context: SubagentContext): Promise<{ ok: boolean; text: string }> {
  const messages: OpenAIChatMessage[] = [
    ...(context.system ? [{ role: "system" as const, content: context.system }] : []),
    { role: "user", content: framing(task) },
  ];
  const label = `Subagent "${task.title}"`;
  for (let round = 0; round < context.limits.rounds; round++) {
    context.signal.throwIfAborted();
    const completion = await context.complete(messages);
    if (!completion.toolCalls.length) {
      const answer = completion.text.trim() || completion.reasoning.trim();
      return answer ? { ok: true, text: answer } : { ok: false, text: "The subagent ended without an answer." };
    }
    messages.push(context.reply(completion, completion.text || null));
    for (const call of completion.toolCalls) {
      context.signal.throwIfAborted();
      let result: ChatToolResult;
      try {
        const args = object(JSON.parse(call.function.arguments));
        if (!args) throw new Error("tool arguments must be a JSON object");
        context.progress(`${task.title}: ${call.function.name}`);
        result = await context.call(call.function.name, args, label);
      } catch (error) {
        if (context.signal.aborted) throw error;
        result = { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, result: result.text }) });
    }
  }
  return { ok: false, text: `The subagent stopped after ${context.limits.rounds} steps without a final answer; the steps it took already ran.` };
}

/** Runs the tasks, at most `limits.concurrent` at a time, and hands back every answer in order. `started` counts this
 * turn's subagents across calls. */
export async function runSubagents(tasks: SubagentTask[], context: SubagentContext, started: { count: number }): Promise<ChatToolResult> {
  const room = context.limits.perTurn - started.count;
  if (room <= 0) return { ok: false, text: `This turn already ran ${context.limits.perTurn} subagents, the most it may. Do the rest yourself.` };
  const accepted = tasks.slice(0, room);
  started.count += accepted.length;
  const answers: Array<{ ok: boolean; text: string }> = [];
  let next = 0;
  const worker = async () => {
    while (next < accepted.length) {
      const index = next++;
      const task = accepted[index]!;
      context.progress(`${task.title}: started`);
      answers[index] = await runOne(task, context).catch((error: unknown) => {
        if (context.signal.aborted) throw error;
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      });
      context.progress(`${task.title}: ${answers[index]!.ok ? "done" : "stopped"}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(context.limits.concurrent, accepted.length) }, worker));
  const sections = accepted.map((task, index) => {
    const answer = answers[index]!;
    const text = answer.text.length > ANSWER_CHARS ? `${answer.text.slice(0, ANSWER_CHARS)}\n[answer cut short]` : answer.text;
    return `## ${task.title}${answer.ok ? "" : " (did not finish)"}\n\n${text}`;
  });
  if (accepted.length < tasks.length) sections.push(`[${tasks.length - accepted.length} more task(s) not started: this turn's subagent limit is ${context.limits.perTurn}.]`);
  return { ok: answers.some((answer) => answer.ok), text: sections.join("\n\n") };
}
