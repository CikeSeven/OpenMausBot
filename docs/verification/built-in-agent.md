# Built-in agent

## Sub-features

- Add a built-in agent connection (API format, base URL, key) and select its model for a bot.
- Run a turn on OpenAI Responses, Chat Completions, Anthropic Messages or Gemini.
- Read, write and edit files, list, search and run commands in the conversation's folder, with approval cards.
- Run subagents with `delegate`; their approval cards appear in the same chat.

## User path

Settings → AI → Built-in agent: enter a name, choose the API format, give the base URL and key, and add the
connection. Choose one of its models for a bot, then chat as with any other engine.

## Driving it

The fixture has no model API of its own, so start a scripted one first. `server/testing/fake-model-server.ts`
answers in each API's stream format; a script that writes a file, delegates a subagent to read it and then answers
is enough:

```ts
import { responsesReply, startFakeModelServer } from "./server/testing/fake-model-server.ts";
let parent = 0, sub = 0;
const server = await startFakeModelServer((call) => {
  if (JSON.stringify(call.body.input).includes("You are a subagent")) {
    return ++sub === 1 ? responsesReply.calls({ id: "r", name: "read_file", args: { path: "hello.txt" } }) : responsesReply.text("read it");
  }
  parent += 1;
  if (parent === 1) return responsesReply.calls({ id: "w", name: "write_file", args: { path: "hello.txt", content: "hello\n" } });
  if (parent === 2) return responsesReply.calls({ id: "d", name: "delegate", args: { tasks: [{ title: "check", prompt: "Read hello.txt." }] } });
  return responsesReply.text("E2E OK");
}, { data: [{ id: "relay-model" }] });
console.log(server.url);
```

```sh
node --experimental-strip-types scripts/control-omb.ts launch
curl -s -X POST http://127.0.0.1:PORT/api/instances/maus -H 'content-type: application/json' \
  -d '{"displayName":"Relay","wire":"openai-responses","url":"FAKE_URL","key":"test"}'
# Copy instanceId as INSTANCE_ID.
pnpm control:omb new-bot --name Agent --url http://127.0.0.1:PORT
pnpm control:omb set-model --bot BOT_ID --instance INSTANCE_ID --model relay-model --url http://127.0.0.1:PORT
pnpm control:omb send --bot BOT_ID --text "Write hello.txt" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 60 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --limit 10 --url http://127.0.0.1:PORT
```

The wait result must be `settled`; the file must be in the task folder under the fixture's
`task-workspaces/BOT_ID/THREAD_ID/`; the digest line must count `write_file` and `Subagents`.

## Gotchas

- A tool chip's title is the tool's own name. A title with a space counts as a shell command in digests.
- A failed call (a command's non-zero exit, an edit whose text was not found) is information for the model and does
  not end the turn; a refusal does, as on the other API engines.
- Subagents get the turn's tools without `delegate` and `ask_user`, and none of the conversation.

### Last exercised

2026-11-03, isolated Linux fixture on port 21226, Responses wire against a scripted fake server. The turn settled
`completed`, `hello.txt` was written in the task folder, a subagent read it back, and the digest read
`tools: write_file ×1, Subagents ×1`. Covered by `server/drivers/maus/*.test.ts` and `server/drivers/wires/wires.test.ts`.
