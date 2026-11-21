import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { GenerateRequest } from "@cinewright/plugin-sdk";
import type { LlmClient } from "../src/plugin.js";

/** A canned provider response. */
export function message(
  over: Partial<Anthropic.Beta.Messages.BetaMessage> & { text?: string } = {},
) {
  const { text, ...rest } = over;
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "served-model",
    content: [{ type: "text", text: text ?? '{"answer":"hello"}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...rest,
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

/** A fake SDK client: records each request, answers with `reply` (or throws what it returns). */
export function fakeClient(
  reply: (
    body: BetaMessageStreamParams,
    signal?: AbortSignal,
  ) => Promise<Anthropic.Beta.Messages.BetaMessage>,
) {
  const sent: BetaMessageStreamParams[] = [];
  const client: LlmClient = {
    beta: {
      messages: {
        stream(body, options) {
          sent.push(body);
          return { finalMessage: () => reply(body, options?.signal) };
        },
      },
    },
  };
  return { client, sent };
}

export const request = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  tier: "mid",
  system: "Answer briefly.",
  messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
  schema: {
    type: "object",
    properties: { answer: { type: "string", minLength: 1, maxLength: 40 } },
    required: ["answer"],
  },
  max_output_tokens: 256,
  ...extra,
});
