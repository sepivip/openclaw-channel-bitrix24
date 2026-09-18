// Secret handling, redaction and typed errors for the Bitrix24 channel plugin.
//
// Nothing in this module performs I/O. It is imported by every other module so
// that a raw secret can never reach a logger by accident.

import { createHash } from "node:crypto";

/**
 * Stable, non-reversible fingerprint used for diagnostics.
 *
 * Mirrors Telegram's `fingerprintTelegramBotToken`: sha256 hex, first 16 chars.
 * Safe to log; never log the secret itself.
 */
export function fingerprintSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);
}

/**
 * Replace the credential segment of a Bitrix24 inbound-webhook URL with `***`.
 *
 * Bitrix inbound webhook URLs look like
 * `https://<portal>/rest/<userId>/<secret>/`; the third path segment IS the
 * credential. Anything that cannot be parsed collapses to `"***"` so an
 * unexpected shape can never leak.
 */
export function redactUrlSecret(url: unknown): string {
  if (typeof url !== "string" || url.trim().length === 0) {
    return "***";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "***";
  }
  const segments = parsed.pathname.split("/");
  const restIndex = segments.indexOf("rest");
  if (restIndex >= 0 && segments.length > restIndex + 2) {
    // /rest/<userId>/<secret>/... -> redact the secret and everything after it.
    for (let i = restIndex + 2; i < segments.length; i += 1) {
      if (segments[i]) {
        segments[i] = "***";
      }
    }
  } else {
    // Unknown shape: redact every non-empty path segment.
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i]) {
        segments[i] = "***";
      }
    }
  }
  parsed.pathname = segments.join("/");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** Fields carried by every wrapped Bitrix24 REST failure. */
export type Bitrix24ErrorFields = {
  /** Allowlisted method name that produced the failure. */
  method: string;
  /** Bitrix `error` code, or a synthetic `transport_*` / `http_*` code. */
  code: string;
  /** Bitrix `error_description`, already free of credentials. */
  description: string;
  /** HTTP status when the failure came from a response. */
  status?: number;
};

/**
 * The ONLY error type the REST client throws for a Bitrix response.
 *
 * Path A handed a raw `AxiosError` (carrying `config.baseURL`, which contains
 * the webhook secret) straight to the logger. Wrapping happens inside the
 * client, before anything can reach a log sink: this object holds no URL, no
 * headers and no request body.
 */
export class Bitrix24Error extends Error {
  override readonly name = "Bitrix24Error";
  readonly method: string;
  readonly code: string;
  readonly description: string;
  readonly status: number | undefined;

  constructor(fields: Bitrix24ErrorFields) {
    super(`bitrix24 ${fields.method} failed: ${fields.code}`);
    this.method = fields.method;
    this.code = fields.code;
    this.description = fields.description;
    this.status = fields.status;
  }

  /** Log-safe projection. Contains no credential material by construction. */
  toLogFields(): { method: string; code: string; description: string; status?: number } {
    return {
      method: this.method,
      code: this.code,
      description: this.description,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

/**
 * Configuration failure. Thrown BEFORE any network call so an account with a
 * missing or unresolvable secret refuses to start (fail-closed, design §2.2).
 */
export class Bitrix24ConfigError extends Error {
  override readonly name = "Bitrix24ConfigError";
  /** Config path that failed, e.g. `channels.bitrix24.botToken`. */
  readonly configPath: string | undefined;

  constructor(message: string, configPath?: string) {
    super(message);
    this.configPath = configPath;
  }
}

/** Type guard usable from tests and from callers that must not import the class. */
export function isBitrix24Error(value: unknown): value is Bitrix24Error {
  return value instanceof Bitrix24Error;
}

/** Type guard for configuration failures. */
export function isBitrix24ConfigError(value: unknown): value is Bitrix24ConfigError {
  return value instanceof Bitrix24ConfigError;
}
