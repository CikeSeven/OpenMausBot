// OpenAI's Responses API at any address, for a connection that names it: the stateless `store: false` form, with
// reasoning returned encrypted so a later round of the same turn can send it back.
// https://developers.openai.com/api/docs/guides/reasoning#encrypted-reasoning-items
import { readResponsesStream, responsesRequest } from "../openai-responses.ts";
import { chatModelRows, fetchModelRows, type ModelWire } from "./model-wire.ts";

export function responsesWire(url: string, key: string): ModelWire {
  const headers = () => ({ authorization: `Bearer ${key}` });
  return {
    request({ model, messages, tools, effort, replay }) {
      const body = responsesRequest({ model, messages, tools, replay, summaries: false });
      const reasoning = effort === undefined ? undefined : effort === "none" ? { effort } : { effort, summary: "auto" };
      return {
        url: `${url}/responses`,
        headers: headers(),
        body: { ...body, include: ["reasoning.encrypted_content"], ...(reasoning ? { reasoning } : {}) },
      };
    },
    read: (body, handlers) => readResponsesStream(body, { reasoning: true, ...handlers }),
    models: async (signal) => chatModelRows(await fetchModelRows(`${url}/models`, headers(), signal)),
    liveness: () => ({ url: `${url}/models`, headers: headers() }),
  };
}
