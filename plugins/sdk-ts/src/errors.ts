/** Error codes every plugin uses (M1.8a). */
export const ERROR_CODES = [
  "invalid_request",
  "unsupported",
  "timeout",
  "cancelled",
  "rate_limited",
  "provider_error",
  "internal",
] as const;

export type PluginErrorCode = (typeof ERROR_CODES)[number];

/** A typed plugin error: never a thrown exception across the plugin boundary. */
export interface PluginError {
  code: PluginErrorCode;
  message: string;
  retryable: boolean;
  data?: unknown;
}

export function pluginError(
  code: PluginErrorCode,
  message: string,
  retryable = false,
  data?: unknown,
): PluginError {
  return { code, message, retryable, ...(data === undefined ? {} : { data }) };
}

export function isPluginError(value: unknown): value is PluginError {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(e.code) &&
    typeof e.message === "string" &&
    typeof e.retryable === "boolean"
  );
}
