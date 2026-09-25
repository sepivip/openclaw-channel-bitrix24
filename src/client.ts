// Method-allowlisted Bitrix24 `imbot.v2` REST client.
//
// Security properties this module is responsible for (design §1, §3, §5):
//   * HARDCODED method allowlist. Any other method name throws SYNCHRONOUSLY,
//     before a request object exists. CRM, Disk, Task and Calendar methods are
//     structurally unreachable: their names are not in the set.
//   * ONE base URL, validated at config load: https only, `/rest/<digits>/<token>/`
//     path shape, host must end with a configured portal domain. No URL taken
//     from event content is ever fetched.
//   * Every failure is wrapped into `Bitrix24Error { method, code, description }`
//     before it can reach a logger. The webhook URL is never a field anywhere.
//   * Token bucket 1.5 req/s burst 20; backoff on QUERY_LIMIT_EXCEEDED (503)
//     and OPERATION_TIME_LIMIT (429).
//   * Node 22 global `fetch` only. No third-party HTTP client, no runtime dependency.

import { Bitrix24ConfigError, Bitrix24Error } from "./secrets.js";

/**
 * The complete set of Bitrix24 REST methods this bridge may ever call.
 * Adding an entry here is a security review event.
 *
 * `imbot.v2.File.upload` is reached from exactly one place: the
 * `bitrix24_send_sheet` agent tool (src/tools.ts), which uploads a validated
 * .xlsx into the current turn's own dialog. Replies never carry media.
 */
export const BITRIX24_METHOD_ALLOWLIST = Object.freeze([
  "imbot.v2.Bot.register",
  "imbot.v2.Bot.update",
  "imbot.v2.Event.get",
  "imbot.v2.Chat.Message.send",
  "imbot.v2.Chat.InputAction.notify",
  "imbot.v2.File.upload",
] as const);

export type Bitrix24Method = (typeof BITRIX24_METHOD_ALLOWLIST)[number];

const ALLOWED_METHODS: ReadonlySet<string> = new Set<string>(BITRIX24_METHOD_ALLOWLIST);

/** Bitrix rate-limit codes that are worth retrying with backoff. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "QUERY_LIMIT_EXCEEDED",
  "OPERATION_TIME_LIMIT",
]);

export const BITRIX24_DEFAULT_TIMEOUT_MS = 20_000;
export const BITRIX24_DEFAULT_RATE_PER_SEC = 1.5;
export const BITRIX24_DEFAULT_BURST = 20;
const DEFAULT_MAX_RETRIES = 3;

/** Path shape of a Bitrix24 inbound webhook: `/rest/<userId>/<secret>/`. */
const REST_PATH_RE = /^\/rest\/\d+\/[A-Za-z0-9_-]+\/$/;

/**
 * Throws synchronously unless `method` is on the hardcoded allowlist.
 * Exported so tests and callers can assert the gate without a client instance.
 */
export function assertAllowedBitrix24Method(method: string): asserts method is Bitrix24Method {
  if (!ALLOWED_METHODS.has(method)) {
    throw new Bitrix24Error({
      method,
      code: "METHOD_NOT_ALLOWED",
      description:
        `Method "${method}" is not on the Bitrix24 bridge allowlist. ` +
        `Allowed: ${BITRIX24_METHOD_ALLOWLIST.join(", ")}.`,
    });
  }
}

/**
 * ESCAPE HATCH FOR OFFLINE TESTS ONLY.
 *
 * `channels.bitrix24.allowInsecureHttpForTests` lets the base URL be plain
 * `http://` so the offline fake-Bitrix stub can be driven without TLS. It is
 * honoured ONLY when the process is explicitly marked as a test environment:
 * `NODE_ENV=test` or `BITRIX24_ALLOW_INSECURE_HTTP=1`. On the pilot neither is
 * set, so the flag is inert even if someone writes it into `openclaw.json`.
 *
 * Never set `BITRIX24_ALLOW_INSECURE_HTTP` in the pilot's `.env` or compose file.
 */
export function insecureHttpEscapeHatchArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || env.BITRIX24_ALLOW_INSECURE_HTTP === "1";
}

export type ValidatedBitrix24BaseUrl = {
  /** Normalised base URL, always ending in `/`. Treat as a secret. */
  baseUrl: string;
  /** Portal host, safe to log. */
  host: string;
  /** Webhook owner user id, safe to log. */
  userId: string;
};

function hostMatchesPortalDomain(host: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  if (!normalized) {
    return false;
  }
  return host === normalized || host.endsWith(`.${normalized}`);
}

/**
 * Validate the configured inbound-webhook URL at CONFIG LOAD time.
 *
 * Rejects anything that is not `https://<host-under-a-configured-portal-domain>/rest/<digits>/<token>/`.
 * Error messages never echo the URL: `Bitrix24ConfigError` messages are logged.
 */
export function validateBitrix24BaseUrl(params: {
  url: unknown;
  portalDomains: readonly string[];
  configPath?: string;
  /** Config request for the http escape hatch; still gated on the env marker. */
  allowInsecureHttpForTests?: boolean;
  env?: NodeJS.ProcessEnv;
}): ValidatedBitrix24BaseUrl {
  const configPath = params.configPath ?? "channels.bitrix24.webhookUrl";
  const insecureAllowed =
    params.allowInsecureHttpForTests === true && insecureHttpEscapeHatchArmed(params.env);
  if (typeof params.url !== "string" || params.url.trim().length === 0) {
    throw new Bitrix24ConfigError("Bitrix24 webhook URL is not configured.", configPath);
  }
  const raw = params.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Bitrix24ConfigError("Bitrix24 webhook URL is not a valid URL.", configPath);
  }
  if (parsed.protocol !== "https:" && !(insecureAllowed && parsed.protocol === "http:")) {
    throw new Bitrix24ConfigError(
      "Bitrix24 webhook URL must use https (plaintext http would expose the REST credential).",
      configPath,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Bitrix24ConfigError(
      "Bitrix24 webhook URL must not carry userinfo credentials.",
      configPath,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Bitrix24ConfigError(
      "Bitrix24 webhook URL must not carry a query string or fragment.",
      configPath,
    );
  }
  const pathname = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  if (!REST_PATH_RE.test(pathname)) {
    throw new Bitrix24ConfigError(
      "Bitrix24 webhook URL path must be /rest/<userId>/<token>/.",
      configPath,
    );
  }
  const domains = params.portalDomains.filter((d) => typeof d === "string" && d.trim().length > 0);
  if (domains.length === 0) {
    throw new Bitrix24ConfigError(
      "Bitrix24 portalDomain is not configured; refusing to trust an arbitrary host.",
      "channels.bitrix24.portalDomain",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!domains.some((domain) => hostMatchesPortalDomain(host, domain))) {
    throw new Bitrix24ConfigError(
      `Bitrix24 webhook host "${host}" is not under a configured portalDomain.`,
      "channels.bitrix24.portalDomain",
    );
  }
  const userId = pathname.split("/")[2] ?? "";
  return { baseUrl: `${parsed.origin}${pathname}`, host, userId };
}

/** Simple token bucket. Deterministic under injected clock/sleep for tests. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #ratePerSec: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #tokens: number;
  #last: number;

  constructor(params: {
    ratePerSec: number;
    burst: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.#ratePerSec = params.ratePerSec;
    this.#capacity = params.burst;
    this.#tokens = params.burst;
    this.#now = params.now ?? (() => Date.now());
    this.#sleep = params.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#last = this.#now();
  }

  #refill(): void {
    const now = this.#now();
    const elapsedMs = Math.max(0, now - this.#last);
    this.#last = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + (elapsedMs / 1000) * this.#ratePerSec);
  }

  /** Wait until one token is available, then consume it. */
  async take(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const deficit = 1 - this.#tokens;
      await this.#sleep(Math.max(1, Math.ceil((deficit / this.#ratePerSec) * 1000)));
    }
  }
}

export type Bitrix24ClientOptions = {
  /** Already-validated base URL (see `validateBitrix24BaseUrl`). Secret. */
  baseUrl: string;
  /** Portal domains the base URL was validated against. Re-checked here. */
  portalDomains: readonly string[];
  timeoutMs?: number;
  ratePerSec?: number;
  burst?: number;
  maxRetries?: number;
  /** Injected for tests. Defaults to the Node 22 global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injected for deterministic jitter in tests. */
  random?: () => number;
  /** See `insecureHttpEscapeHatchArmed`. Test-only, env-gated. */
  allowInsecureHttpForTests?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type Bitrix24CallOptions = {
  signal?: AbortSignal;
  /**
   * Per-call timeout override in ms. Must be a positive integer; anything else
   * falls back to the client default (20 s). Used by the file upload (60 s).
   */
  timeoutMs?: number;
  /**
   * `false` = a transport failure or timeout is NOT retried. For a call that
   * is not idempotent (a file upload): the first request may already have
   * been processed, and a retry would post the file twice. Rate-limit
   * responses, which Bitrix rejects before doing anything, are still retried.
   * Default `true`, the historical behaviour.
   */
  retryTransportErrors?: boolean;
};

/** Upper bound for a per-call timeout override (Bitrix cloud allows 60 s per request). */
export const BITRIX24_MAX_CALL_TIMEOUT_MS = 120_000;

function resolveCallTimeoutMs(override: unknown, fallback: number): number {
  if (
    typeof override === "number" &&
    Number.isInteger(override) &&
    override > 0 &&
    override <= BITRIX24_MAX_CALL_TIMEOUT_MS
  ) {
    return override;
  }
  return fallback;
}

export type Bitrix24Client = {
  /**
   * Call an allowlisted Bitrix24 method.
   *
   * NOTE: deliberately NOT an `async` function. A non-allowlisted method name
   * throws synchronously instead of producing a rejected promise.
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: Bitrix24CallOptions,
  ): Promise<T>;
  /** Log-safe description of the endpoint. Contains no credential. */
  describe(): { host: string; userId: string };
};

type BitrixEnvelope = {
  result?: unknown;
  error?: string;
  error_description?: string;
};

function describeEnvelopeError(method: string, status: number, body: unknown): Bitrix24Error {
  const envelope = (body ?? {}) as BitrixEnvelope;
  const code =
    typeof envelope.error === "string" && envelope.error.length > 0
      ? envelope.error
      : `http_${status}`;
  const description =
    typeof envelope.error_description === "string" && envelope.error_description.length > 0
      ? envelope.error_description
      : `Bitrix24 returned HTTP ${status}.`;
  return new Bitrix24Error({ method, code, description, status });
}

export function createBitrix24Client(options: Bitrix24ClientOptions): Bitrix24Client {
  // Re-validate: a client can only ever be built around a conforming URL.
  const validated = validateBitrix24BaseUrl({
    url: options.baseUrl,
    portalDomains: options.portalDomains,
    ...(options.allowInsecureHttpForTests === undefined
      ? {}
      : { allowInsecureHttpForTests: options.allowInsecureHttpForTests }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const timeoutMs = options.timeoutMs ?? BITRIX24_DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const bucket = new TokenBucket({
    ratePerSec: options.ratePerSec ?? BITRIX24_DEFAULT_RATE_PER_SEC,
    burst: options.burst ?? BITRIX24_DEFAULT_BURST,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  async function execute<T>(
    method: Bitrix24Method,
    params: Record<string, unknown>,
    callOptions: Bitrix24CallOptions | undefined,
  ): Promise<T> {
    let lastError: Bitrix24Error | undefined;
    const callTimeoutMs = resolveCallTimeoutMs(callOptions?.timeoutMs, timeoutMs);
    const retryTransport = callOptions?.retryTransportErrors !== false;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await bucket.take();
      const timeoutSignal = AbortSignal.timeout(callTimeoutMs);
      const signal = callOptions?.signal
        ? AbortSignal.any([callOptions.signal, timeoutSignal])
        : timeoutSignal;

      let response: Response;
      try {
        response = await doFetch(`${validated.baseUrl}${method}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(params),
          signal,
          redirect: "error",
        });
      } catch (cause) {
        // Wrap BEFORE anything can log it: a raw fetch error can carry the URL.
        const aborted = callOptions?.signal?.aborted === true;
        lastError = new Bitrix24Error({
          method,
          code: aborted ? "ABORTED" : "TRANSPORT_ERROR",
          description: aborted
            ? "Request aborted by caller."
            : `Network request failed or timed out after ${callTimeoutMs}ms.`,
        });
        if (aborted || !retryTransport) {
          throw lastError;
        }
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt, random));
          continue;
        }
        throw lastError;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (response.ok) {
        const envelope = (body ?? {}) as BitrixEnvelope;
        if (typeof envelope.error === "string" && envelope.error.length > 0) {
          const error = describeEnvelopeError(method, response.status, body);
          if (RETRYABLE_CODES.has(error.code) && attempt < maxRetries) {
            lastError = error;
            await sleep(backoffMs(attempt, random));
            continue;
          }
          throw error;
        }
        return envelope.result as T;
      }

      const error = describeEnvelopeError(method, response.status, body);
      const retryable =
        RETRYABLE_CODES.has(error.code) || response.status === 429 || response.status === 503;
      if (retryable && attempt < maxRetries) {
        lastError = error;
        await sleep(backoffMs(attempt, random));
        continue;
      }
      throw error;
    }
    throw (
      lastError ??
      new Bitrix24Error({
        method,
        code: "RETRIES_EXHAUSTED",
        description: `Gave up after ${maxRetries + 1} attempts.`,
      })
    );
  }

  return {
    call<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
      callOptions?: Bitrix24CallOptions,
    ): Promise<T> {
      // Synchronous gate. Never turn this function into `async`.
      assertAllowedBitrix24Method(method);
      return execute<T>(method, params, callOptions);
    },
    describe() {
      return { host: validated.host, userId: validated.userId };
    },
  };
}

/** Exponential backoff with full jitter, capped at 30s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.floor(base / 2 + random() * (base / 2));
}
