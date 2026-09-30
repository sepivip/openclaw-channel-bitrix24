// READ-ONLY Bitrix24 REST client for the business-pulse data tool (customer
// calls, i.e. CRM deals).
//
// Security properties this module is responsible for:
//   * A SEPARATE client with its OWN webhook (`channels.bitrix24.crmWebhookUrl`,
//     created by a low-privilege service user). The `imbot` client in
//     src/client.ts, its allowlist and T-7 are untouched; this module only
//     reuses its exported URL validator, token bucket and backoff helpers.
//   * HARDCODED allowlist of three CRM list methods. Any other method name
//     throws SYNCHRONOUSLY, before a request object exists. No `batch`: a batch
//     call would carry arbitrary method names inside its body.
//   * The base URL is validated like the imbot webhook: https only,
//     `/rest/<digits>/<token>/`, host under a configured portal domain.
//   * At most 2 requests per second (one request start every 500 ms, the
//     non-Enterprise Bitrix limit), 60 s per request, one retry with backoff
//     on QUERY_LIMIT_EXCEEDED / OPERATION_TIME_LIMIT (or a bare 503/429:
//     every call here is a read, so a repeat cannot change anything).
//   * Every failure is a `Bitrix24Error` with a FIXED description. Neither the
//     URL, the token, Bitrix's `error_description` nor any response body is
//     ever put into an error or a log line. Logs carry the method, the attempt,
//     the outcome code, counts and elapsed time only.
//   * Paging: 50 per page via `start` and the response `next`, capped at
//     `BITRIX24_CRM_MAX_PAGES`; hitting the cap is reported as `truncated`.
//   * Node 22 global `fetch` only. No runtime dependency.

import { TokenBucket, backoffMs, validateBitrix24BaseUrl } from "./client.js";
import type { Bitrix24Log } from "./inbound.js";
import { Bitrix24Error } from "./secrets.js";

/**
 * The complete set of Bitrix24 REST methods the pulse may ever call through
 * the CRM webhook: deals, pipelines, stages. All are list reads. Adding an
 * entry here is a security review event; a write method must never be added.
 */
export const BITRIX24_CRM_READ_METHOD_ALLOWLIST = Object.freeze([
  "crm.item.list",
  "crm.category.list",
  "crm.status.list",
] as const);

export type Bitrix24CrmReadMethod = (typeof BITRIX24_CRM_READ_METHOD_ALLOWLIST)[number];

const ALLOWED_CRM_READ_METHODS: ReadonlySet<string> = new Set<string>(BITRIX24_CRM_READ_METHOD_ALLOWLIST);

/** At most this many request starts per second (Bitrix non-Enterprise limit). */
export const BITRIX24_CRM_MAX_RATE_PER_SEC = 2;
/** Per-request timeout, and its upper bound (Bitrix cloud allows 60 s per request). */
export const BITRIX24_CRM_TIMEOUT_MS = 60_000;
/** Bitrix list methods return 50 rows per page; `start` moves in steps of 50. */
export const BITRIX24_CRM_PAGE_SIZE = 50;
/** Hard page cap per listing: 40 pages = 2,000 rows. Beyond it the listing is `truncated`. */
export const BITRIX24_CRM_MAX_PAGES = 40;
/** One retry, and only on a rate-limit answer. */
const MAX_RETRIES = 1;

/** Bitrix codes that mean "rejected before running; try again shortly". */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["QUERY_LIMIT_EXCEEDED", "OPERATION_TIME_LIMIT"]);
/** Bitrix codes that mean the webhook or its user may not do this. */
const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set(["INSUFFICIENT_SCOPE", "ACCESS_DENIED"]);
/**
 * Some modules wrap a permission failure into a generic code (`ERROR_CORE`)
 * and say so only in `error_description`. The description is inspected for
 * this marker and then dropped; it is never stored or logged.
 */
const ACCESS_DENIED_DESCRIPTION_RE = /ACCESS_DENIED|access denied/i;
/** A Bitrix error code that is safe to carry: a short token, no content. */
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Fixed, content-free descriptions. Never Bitrix's own text. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  METHOD_NOT_ALLOWED: "method is not on the read-only CRM allowlist",
  ACCESS_DENIED: "the CRM webhook or its user may not read this",
  QUERY_LIMIT_EXCEEDED: "Bitrix24 request rate limit",
  OPERATION_TIME_LIMIT: "Bitrix24 operation time limit",
  TIMEOUT: "Bitrix24 did not answer in time",
  TRANSPORT_ERROR: "Bitrix24 could not be reached",
  ABORTED: "request aborted",
  INVALID_RESPONSE: "Bitrix24 answered in an unexpected shape",
};

function crmError(method: string, code: string, status?: number): Bitrix24Error {
  return new Bitrix24Error({
    method,
    code,
    description: DESCRIPTIONS[code] ?? "Bitrix24 returned an error",
    ...(status === undefined ? {} : { status }),
  });
}

/**
 * Throws synchronously unless `method` is on the CRM read allowlist.
 * Exported so tests and callers can assert the gate without a client.
 */
export function assertAllowedBitrix24CrmReadMethod(
  method: string,
): asserts method is Bitrix24CrmReadMethod {
  if (!ALLOWED_CRM_READ_METHODS.has(method)) {
    throw new Bitrix24Error({
      method,
      code: "METHOD_NOT_ALLOWED",
      description:
        `Method "${method}" is not on the Bitrix24 read-only CRM allowlist. ` +
        `Allowed: ${BITRIX24_CRM_READ_METHOD_ALLOWLIST.join(", ")}.`,
    });
  }
}

export type Bitrix24CrmClientOptions = {
  /** The CRM webhook base URL. Secret; validated again here. */
  baseUrl: string;
  portalDomains: readonly string[];
  /** Test override; clamped to (0, 60 s]. */
  timeoutMs?: number;
  /** Test override; clamped to at most 2. */
  ratePerSec?: number;
  /** Test override; clamped to [1, 40]. */
  maxPages?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: Bitrix24Log;
  /** See `insecureHttpEscapeHatchArmed` in client.ts. Test-only, env-gated. */
  allowInsecureHttpForTests?: boolean;
  env?: NodeJS.ProcessEnv;
};

/** Counts HTTP requests (retries included) for the caller's `meta`. */
export type Bitrix24CrmRequestStats = { requests: number };

export type Bitrix24CrmCallOptions = {
  signal?: AbortSignal;
  stats?: Bitrix24CrmRequestStats;
};

/** One Bitrix answer: `result` plus the paging fields when present. */
export type Bitrix24CrmPage<T> = {
  result: T;
  total: number | undefined;
  next: number | undefined;
};

export type Bitrix24CrmListResult<T> = {
  items: T[];
  /** `total` from the first page, when Bitrix sent one. */
  total: number | undefined;
  /** True when the page cap stopped the listing before Bitrix's last page. */
  truncated: boolean;
  pages: number;
};

export type Bitrix24CrmClient = {
  /**
   * Call one allowlisted read method. Deliberately NOT `async`: a method that
   * is not allowlisted throws synchronously instead of returning a rejection.
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: Bitrix24CrmCallOptions,
  ): Promise<Bitrix24CrmPage<T>>;
  /**
   * Page through an allowlisted list method (`start`/`next`), up to the page
   * cap. `extract` picks the row array out of `result`; `undefined` means the
   * answer has the wrong shape. Also synchronous on a disallowed method.
   */
  list<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    extract: (result: unknown) => T[] | undefined,
    options?: Bitrix24CrmCallOptions,
  ): Promise<Bitrix24CrmListResult<T>>;
  /** Log-safe description of the endpoint. Contains no credential. */
  describe(): { host: string; userId: string };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCount(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** Map a Bitrix error answer to the code this client reports. */
function classifyBitrixError(rawCode: unknown, status: number, rawDescription: unknown): string {
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  const upper = code.toUpperCase();
  if (RETRYABLE_CODES.has(upper)) {
    return upper;
  }
  if (
    ACCESS_DENIED_CODES.has(upper) ||
    status === 401 ||
    status === 403 ||
    (typeof rawDescription === "string" && ACCESS_DENIED_DESCRIPTION_RE.test(rawDescription))
  ) {
    return "ACCESS_DENIED";
  }
  if (code === "") {
    return `http_${status}`;
  }
  return SAFE_CODE_RE.test(code) ? code : "BITRIX_ERROR";
}

function logAt(log: Bitrix24Log | undefined, level: "debug" | "warn", text: string): void {
  const sink = log?.[level];
  if (typeof sink === "function") {
    sink(text);
  }
}

export function createBitrix24CrmClient(options: Bitrix24CrmClientOptions): Bitrix24CrmClient {
  const validated = validateBitrix24BaseUrl({
    url: options.baseUrl,
    portalDomains: options.portalDomains,
    configPath: "channels.bitrix24.crmWebhookUrl",
    ...(options.allowInsecureHttpForTests === undefined
      ? {}
      : { allowInsecureHttpForTests: options.allowInsecureHttpForTests }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const timeoutMs = clamp(options.timeoutMs, 1, BITRIX24_CRM_TIMEOUT_MS, BITRIX24_CRM_TIMEOUT_MS);
  const ratePerSec = clamp(
    options.ratePerSec,
    0.01,
    BITRIX24_CRM_MAX_RATE_PER_SEC,
    BITRIX24_CRM_MAX_RATE_PER_SEC,
  );
  const maxPages = Math.floor(clamp(options.maxPages, 1, BITRIX24_CRM_MAX_PAGES, BITRIX24_CRM_MAX_PAGES));
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const log = options.log;
  // Burst 1: every request start waits until 1/ratePerSec has passed since
  // the previous one, so no 1-second window ever holds more than 2 starts.
  const bucket = new TokenBucket({ ratePerSec, burst: 1, now, sleep });

  async function execute<T>(
    method: Bitrix24CrmReadMethod,
    params: Record<string, unknown>,
    callOptions: Bitrix24CrmCallOptions | undefined,
  ): Promise<Bitrix24CrmPage<T>> {
    const callerSignal = callOptions?.signal;
    for (let attempt = 0; ; attempt += 1) {
      if (callerSignal?.aborted) {
        throw crmError(method, "ABORTED");
      }
      await bucket.take();
      if (callerSignal?.aborted) {
        throw crmError(method, "ABORTED");
      }
      if (callOptions?.stats) {
        callOptions.stats.requests += 1;
      }
      const started = now();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
      const done = (outcome: string, extra = "") =>
        logAt(
          log,
          "debug",
          `[bitrix24] crm read method=${method} attempt=${attempt + 1} outcome=${outcome}` +
            `${extra} ms=${Math.max(0, now() - started)}`,
        );

      let response: Response;
      try {
        response = await doFetch(`${validated.baseUrl}${method}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(params),
          signal,
          redirect: "error",
        });
      } catch {
        // Never the raw error: it can carry the URL.
        const code = callerSignal?.aborted ? "ABORTED" : timeoutSignal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR";
        done(code);
        throw crmError(method, code);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      const envelope = isPlainObject(body) ? body : {};
      const hasError = typeof envelope.error === "string" && envelope.error.length > 0;
      if (response.ok && !hasError) {
        if (!isPlainObject(body) || !("result" in body)) {
          done("INVALID_RESPONSE");
          throw crmError(method, "INVALID_RESPONSE", response.status);
        }
        const total = readCount(envelope.total);
        const next = readCount(envelope.next);
        done("ok", total === undefined ? "" : ` total=${total}`);
        return { result: body.result as T, total, next };
      }

      const code = classifyBitrixError(envelope.error, response.status, envelope.error_description);
      const retryable =
        RETRYABLE_CODES.has(code) ||
        (!hasError && (response.status === 429 || response.status === 503));
      done(code, ` status=${response.status}`);
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(backoffMs(1, random));
        continue;
      }
      if (retryable) {
        logAt(log, "warn", `[bitrix24] crm read method=${method} gave up after ${attempt + 1} attempts code=${code}`);
      }
      throw crmError(method, code, response.status);
    }
  }

  async function listPages<T>(
    method: Bitrix24CrmReadMethod,
    params: Record<string, unknown>,
    extract: (result: unknown) => T[] | undefined,
    callOptions: Bitrix24CrmCallOptions | undefined,
  ): Promise<Bitrix24CrmListResult<T>> {
    const items: T[] = [];
    let start = 0;
    let pages = 0;
    let total: number | undefined;
    let truncated = false;
    for (;;) {
      const page = await execute<unknown>(method, { ...params, start }, callOptions);
      pages += 1;
      const rows = extract(page.result);
      if (!Array.isArray(rows)) {
        throw crmError(method, "INVALID_RESPONSE");
      }
      items.push(...rows);
      if (pages === 1) {
        total = page.total;
      }
      if (page.next === undefined) {
        break;
      }
      if (page.next <= start) {
        // A `next` that does not move forward would loop: never guess.
        throw crmError(method, "INVALID_RESPONSE");
      }
      if (pages >= maxPages) {
        truncated = true;
        break;
      }
      start = page.next;
    }
    logAt(
      log,
      "debug",
      `[bitrix24] crm list method=${method} pages=${pages} rows=${items.length}` +
        `${total === undefined ? "" : ` total=${total}`} truncated=${truncated}`,
    );
    return { items, total, truncated, pages };
  }

  return {
    call<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
      callOptions?: Bitrix24CrmCallOptions,
    ): Promise<Bitrix24CrmPage<T>> {
      // Synchronous gate. Never turn this function into `async`.
      assertAllowedBitrix24CrmReadMethod(method);
      return execute<T>(method, params, callOptions);
    },
    list<T = unknown>(
      method: string,
      params: Record<string, unknown>,
      extract: (result: unknown) => T[] | undefined,
      callOptions?: Bitrix24CrmCallOptions,
    ): Promise<Bitrix24CrmListResult<T>> {
      // Synchronous gate. Never turn this function into `async`.
      assertAllowedBitrix24CrmReadMethod(method);
      return listPages<T>(method, params, extract, callOptions);
    },
    describe() {
      return { host: validated.host, userId: validated.userId };
    },
  };
}
