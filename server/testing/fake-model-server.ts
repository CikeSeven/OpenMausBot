// A loopback HTTP server that answers model API requests from a script, for the built-in agent's wire and loop tests.
// Each reply follows the provider's documented stream shape; no model is called.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";

export interface FakeModelCall {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

export type FakeReply =
  | { status: number; json: unknown }
  | { sse: unknown[]; named?: boolean; cut?: boolean };

export interface FakeModelServer {
  /** The base URL, ending in /v1. */
  url: string;
  calls: FakeModelCall[];
  close(): Promise<void>;
}

function send(response: ServerResponse, reply: FakeReply) {
  if ("json" in reply) {
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.json));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of reply.sse) {
    const name = reply.named ? `event: ${String((frame as { type?: unknown }).type)}\n` : "";
    response.write(`${name}data: ${JSON.stringify(frame)}\n\n`);
  }
  if (reply.cut) response.destroy();
  else response.end();
}

/** `models` answers every GET; `reply` answers every POST, given the call and its 1-based position. */
export async function startFakeModelServer(
  reply: (call: FakeModelCall, nth: number) => FakeReply,
  models: unknown = { data: [] },
): Promise<FakeModelServer> {
  const calls: FakeModelCall[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(models));
      return;
    }
    let data = "";
    for await (const part of request) data += part.toString();
    const call = { method: request.method, path: request.url ?? "", headers: request.headers, body: JSON.parse(data) as Record<string, any> };
    calls.push(call);
    send(response, reply(call, calls.length));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake model server did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** OpenAI Responses stream frames. */
export const responsesReply = {
  text: (text: string): FakeReply => ({ sse: [
    { type: "response.output_text.delta", item_id: "msg_1", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ] }),
  calls: (...calls: Array<{ id: string; name: string; args: unknown }>): FakeReply => ({ sse: [
    ...calls.map((call, index) => ({
      type: "response.output_item.done", output_index: index,
      item: { type: "function_call", id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) },
    })),
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
  ] }),
};

/** Anthropic Messages stream frames, each sent with its `event:` name. */
export const anthropicReply = {
  text: (text: string, thinking?: string): FakeReply => ({ named: true, sse: [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...(thinking ? [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
    ] : []),
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ] }),
  calls: (thinking: string | undefined, ...calls: Array<{ id: string; name: string; args: unknown }>): FakeReply => ({ named: true, sse: [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    ...(thinking ? [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
    ] : []),
    ...calls.flatMap((call, position) => {
      const json = JSON.stringify(call.args);
      const index = position + 1;
      return [
        { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(5) } },
        { type: "content_block_stop", index },
      ];
    }),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ] }),
};

/** Gemini streamGenerateContent frames. Calls carry no id, as on Gemini 2.x. */
export const geminiReply = {
  text: (text: string): FakeReply => ({ sse: [
    { candidates: [{ content: { role: "model", parts: [{ text: text.slice(0, 3) }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: text.slice(3) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  ] }),
  calls: (...calls: Array<{ name: string; args: unknown; signature?: string }>): FakeReply => ({ sse: [
    { candidates: [{ content: { role: "model", parts: calls.map((call) => ({
      functionCall: { name: call.name, args: call.args }, ...(call.signature ? { thoughtSignature: call.signature } : {}),
    })) }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  ] }),
};
