# llm-anthropic

The reference LLM plugin (M7.3): kind `llm`, in process, Apache-2.0. Methods `llm.generate` and `llm.estimate`. It is the only place in the repository where a vendor SDK (`@anthropic-ai/sdk`, pinned at 1.12.0) or a model id may appear; `cinewright-check-boundaries` fails on either anywhere else (rules `vendor-sdk` and `model-id`). Core and engine name tiers (`frontier`, `mid`) and opaque pins only.

## What it does

- **Typed output:** each request carries the role's full JSON Schema. `providerSchema` reduces it to what the provider's structured output accepts: every object is closed, and unsupported keywords are dropped. The reduced schema goes in `output_config.format` (`{ type: "json_schema", schema }`). The agent runner always validates the output against the full schema afterwards. A map (`additionalProperties` other than `false`) or a recursive schema can't be reduced and is `invalid_request`.
- **Models:** `settings.json` maps `tiers` and `pins` to model ids. An unknown pin is `invalid_request`. The result reports the model that answered (`response.model`).
- **Effort:** `output_config.effort` takes the request's `effort`, else `default_effort`. No `thinking` field is sent (it's on by default on these models), and no sampling parameter or prefill.
- **Refusal fallback:** server-side fallback is on (`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`). Setting `fallbacks.mode` to `null` turns it off. A refusal by the whole chain (`stop_reason: "refusal"`) is a non-retryable `provider_error`, with `data.category` from `stop_details`.
- **Cost:** `cost_usd` is computed from the response's usage at the prices in `settings.json`. A model that isn't listed (one a fallback chose) is charged at the dearest listed price. `llm.estimate` is offline: input tokens from text length and a fixed count per image, output at the full `max_output_tokens`.
- **Errors:**
  - 429 → `rate_limited`;
  - 5xx, timeouts and the network → retryable `provider_error`;
  - 400 → `invalid_request`;
  - other 4xx (key, permission, billing) → `provider_error`, not retried.

  The SDK's own retries are off (`maxRetries: 0`), because the scheduler retries and falls back (M7.2). Every message is scrubbed of the key.
- **Images:** read from the plugin's work folder and sent base64. Cassettes key them by content hash, never by path.

## Cassettes

`withCassettes` (engine, `engine/src/agents/cassette.ts`) wraps this plugin. Settings: `CINEWRIGHT_CASSETTE_MODE` (`replay` | `record` | `off`) and `CINEWRIGHT_CASSETTES`. `test/cassettes/` holds a cassette recorded from the fake provider in the tests (`CINEWRIGHT_RECORD_FIXTURE=1` rewrites it). It is not a live response.

## Live test

`CINEWRIGHT_LIVE_TESTS=1` with `ANTHROPIC_API_KEY` set runs one short request to the mid tier, capped at 64 output tokens. It never runs in required CI or on forks, and it was not run for M7.3.

## Provider facts (re-checked 2026-11-21)

Sources: Anthropic's developer reference as bundled with Claude Code (cached 2026-11-03), and the installed SDK 1.12.0's type definitions (published 2026-11-20).

- **Structured output** uses `output_config: { format: { type: "json_schema", schema } }`; the older `output_format` is deprecated.
  - Supported: object, array, string, integer, number, boolean, null; `enum`, `const`, `anyOf`, `allOf`, `$ref`/`$defs`; formats `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`; `additionalProperties: false`, required on every object.
  - Not supported: recursive schemas, numeric constraints, string length constraints, complex array constraints, `additionalProperties` other than `false`.
  - It can't be combined with citations or prefill.
  - `pattern` is not listed either way, so it is dropped to be safe; the full schema still checks it.
- **Rejected request fields:** `temperature`, `top_p` and `top_k` are removed on current models. Forced `tool_choice` (`any` / `tool`) is a 400 on the current Opus and Sonnet. Assistant prefill is a 400. On the current Opus, `thinking: { type: "disabled" }` or a thinking budget is a 400; effort is the only control, and its default is `medium`.
- **Refusal:** HTTP 200 with `stop_reason: "refusal"` and `stop_details: { type, category, explanation }`.
- **Usage:** `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (this plugin sets no cache breakpoints).
- **Prices** (USD per million tokens, first-party API): `claude-opus-5-5` $4 in, $20 out, $0.20 cache read; `claude-sonnet-5-5` $2, $10, $0.10.
- **Images:** base64 `image/jpeg`, `image/png`, `image/gif`, `image/webp`. *Not verified here:* the per-image size and pixel limits.
- **SDK error classes:** `RateLimitError`, `InternalServerError`, `APIConnectionError` (a subclass of `APIError` in TypeScript), `BadRequestError`, `AuthenticationError`, and `APIUserAbortError` for a cancelled request.
