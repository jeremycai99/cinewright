import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { GenerateRequest } from "@cinewright/plugin-sdk";
import { providerSchema } from "./schema.js";
import type { Settings } from "./settings.js";

export class UnknownPinError extends Error {
  override name = "UnknownPinError";
}

/** The model a request routes to: its pin, else its tier. */
export function modelFor(settings: Settings, request: GenerateRequest): string {
  if (request.pin !== undefined) {
    const model = settings.pins[request.pin];
    if (!model) throw new UnknownPinError(`no pin ${request.pin} in the plugin's settings`);
    return model;
  }
  return settings.tiers[request.tier];
}

type ImageMedia = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * The provider request (M7.3): structured output through `output_config.format` with the reduced
 * schema, effort through `output_config.effort`, images as base64 from the work folder. No
 * `thinking` field (on by default on these models), no sampling parameter, no prefill.
 */
export function buildParams(
  settings: Settings,
  request: GenerateRequest,
  workDir: string,
): BetaMessageStreamParams {
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = request.messages.map((m) => ({
    role: m.role,
    content: m.content.map((c) =>
      c.type === "text"
        ? { type: "text" as const, text: c.text }
        : {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: c.media_type as ImageMedia,
              data: readFileSync(join(workDir, c.file)).toString("base64"),
            },
          },
    ),
  }));
  return {
    model: modelFor(settings, request),
    max_tokens: request.max_output_tokens,
    system: request.system,
    messages,
    output_config: {
      effort: request.effort ?? settings.default_effort,
      format: { type: "json_schema", schema: providerSchema(request.schema) },
    },
    ...(settings.fallbacks.mode
      ? { betas: [settings.fallbacks.beta], fallbacks: settings.fallbacks.mode }
      : {}),
  };
}
