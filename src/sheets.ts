// Server-built spreadsheet exports, fetched from the local export sidecar.
//
// Security properties this module is responsible for:
//   * ONE pinned URL, a constant: loopback, one path. It is not configurable,
//     nothing from tool arguments or event content can change it, and a
//     redirect is an error (`redirect: "error"`).
//   * The bearer token comes from the gateway environment only
//     (`ONESOFT_MCP_TOKEN`). Missing or shorter than 32 characters: refuse
//     before any request exists.
//   * The response is size-capped BEFORE it is parsed, and then validated
//     strictly: `ok === true`, the file name pattern, the exact spreadsheet
//     MIME type, canonical Base64, the zip signature `PK\x03\x04`, the decoded
//     size cap, and the exact type of every summary field.
//   * This module never logs. Its errors carry a fixed code and a fixed short
//     message: never the token, the URL, the file bytes or any row data.
//   * Node 22 global `fetch` only. No runtime dependency.

/** The pinned export endpoint. Loopback only, not configurable. */
export const SHEETS_STOCK_EXPORT_URL = "http://127.0.0.1:8765/exports/stock";

/** Gateway env var holding the export bearer token. */
export const SHEETS_TOKEN_ENV = "ONESOFT_MCP_TOKEN";
export const SHEETS_MIN_TOKEN_LENGTH = 32;

/** The export reads a whole 1C register; allow it time. */
export const SHEETS_FETCH_TIMEOUT_MS = 180_000;
/** Raw response cap, checked before JSON parsing (Base64 of 5 MiB is ~7 MB). */
export const SHEETS_MAX_RESPONSE_BYTES = 7_864_320;
/** Error bodies are small JSON objects; never read more than this. */
const SHEETS_MAX_ERROR_BODY_BYTES = 16_384;
/** Decoded .xlsx cap. */
export const SHEETS_MAX_FILE_BYTES = 5 * 1024 * 1024;

export const SHEETS_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** ASCII, no leading dot, no path separators, `.xlsx` suffix. */
export const SHEETS_FILE_NAME_RE = /^(?!\.)[A-Za-z0-9._-]{1,120}\.xlsx$/;
export const SHEETS_WAREHOUSE_CODE_RE = /^[A-Za-z0-9-]{1,32}$/;
export const SHEETS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_STRING_RE = /^-?\d{1,30}(\.\d{1,12})?$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const UPSTREAM_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** C0 controls, DEL and C1 controls. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;

export type SheetLang = "en" | "ka";

export type StockExportRequest = {
  warehouse_code?: string;
  as_of?: string;
  lang?: SheetLang;
};

export type StockExportSummary = {
  kind: "stock";
  as_of: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  rows: number;
  total_rows_available: number;
  total_quantity: string;
  total_quantity_all: string;
  truncated: boolean;
  row_cap: number;
  byte_cap: number;
  source: string;
  /** Lines without an item name. Optional on the wire; 0 when absent. */
  items_without_name: number;
  /** Lines whose amount was null upstream. Optional on the wire; 0 when absent. */
  null_amounts: number;
};

export type StockExport = {
  fileName: string;
  mimeType: typeof SHEETS_XLSX_MIME;
  /** Canonical Base64 of `bytes`, ready for `imbot.v2.File.upload`. */
  contentBase64: string;
  /** Decoded length in bytes. */
  byteLength: number;
  summary: StockExportSummary;
};

export type SheetExportErrorCode =
  | "EXPORT_NOT_CONFIGURED"
  | "EXPORT_INVALID_REQUEST"
  | "EXPORT_UNAUTHORIZED"
  | "EXPORT_BAD_REQUEST"
  | "EXPORT_NOT_FOUND"
  | "EXPORT_TOO_LARGE"
  | "EXPORT_NAMES_UNAVAILABLE"
  | "EXPORT_UNAVAILABLE"
  | "EXPORT_TIMEOUT"
  | "EXPORT_UNREACHABLE"
  | "EXPORT_UPSTREAM_ERROR"
  | "EXPORT_INVALID_RESPONSE"
  | "EXPORT_ABORTED";

/** Log-safe export failure: a fixed code and a fixed short message. */
export class SheetExportError extends Error {
  override readonly name = "SheetExportError";
  readonly code: SheetExportErrorCode;
  /** HTTP status of the export response, when there was one. */
  readonly status: number | undefined;
  /** The sidecar's own error code, only when it matched a safe token pattern. */
  readonly upstreamCode: string | undefined;

  constructor(
    code: SheetExportErrorCode,
    message: string,
    extra: { status?: number; upstreamCode?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.status = extra.status;
    this.upstreamCode = extra.upstreamCode;
  }
}

export function isSheetExportError(value: unknown): value is SheetExportError {
  return value instanceof SheetExportError;
}

/** True for a real calendar date in `YYYY-MM-DD`. */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !SHEETS_DATE_RE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The export token, or `undefined` when it is missing or too short. Never logged. */
export function readSheetsExportToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[SHEETS_TOKEN_ENV];
  const token = typeof raw === "string" ? raw.trim() : "";
  if (token.length < SHEETS_MIN_TOKEN_LENGTH || /\s/.test(token)) {
    return undefined;
  }
  return token;
}

function invalidResponse(message: string): SheetExportError {
  return new SheetExportError("EXPORT_INVALID_RESPONSE", `export response rejected: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeLabel(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHAR_RE.test(value)
  );
}

/**
 * Strict Base64 decode: standard alphabet, correct padding, and the decoded
 * bytes must re-encode to the same string (Node's decoder is lenient on its own).
 */
export function decodeStrictBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    return undefined;
  }
  if (!BASE64_RE.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    return undefined;
  }
  return bytes;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Validate the summary object exactly. `request` is used for consistency
 * checks: the file must be for the warehouse and the date the tool asked for.
 * `items_without_name` and `null_amounts` are optional (an older export
 * service does not send them) and default to 0.
 */
export function validateStockExportSummary(
  raw: unknown,
  request: StockExportRequest = {},
): StockExportSummary {
  if (!isPlainObject(raw)) {
    throw invalidResponse("summary is not an object");
  }
  if (raw.kind !== "stock") {
    throw invalidResponse("summary.kind is not stock");
  }
  if (!isValidIsoDate(raw.as_of)) {
    throw invalidResponse("summary.as_of is not a YYYY-MM-DD date");
  }
  const code = raw.warehouse_code;
  if (!(code === null || (typeof code === "string" && SHEETS_WAREHOUSE_CODE_RE.test(code)))) {
    throw invalidResponse("summary.warehouse_code has the wrong type");
  }
  const name = raw.warehouse_name;
  if (!(name === null || isSafeLabel(name, 200))) {
    throw invalidResponse("summary.warehouse_name has the wrong type");
  }
  for (const key of ["rows", "total_rows_available", "row_cap", "byte_cap"] as const) {
    if (!isNonNegativeInt(raw[key])) {
      throw invalidResponse(`summary.${key} is not a non-negative integer`);
    }
  }
  for (const key of ["items_without_name", "null_amounts"] as const) {
    if (raw[key] !== undefined && !isNonNegativeInt(raw[key])) {
      throw invalidResponse(`summary.${key} is not a non-negative integer`);
    }
  }
  for (const key of ["total_quantity", "total_quantity_all"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || !DECIMAL_STRING_RE.test(value)) {
      throw invalidResponse(`summary.${key} is not a decimal string`);
    }
  }
  if (typeof raw.truncated !== "boolean") {
    throw invalidResponse("summary.truncated is not a boolean");
  }
  if (!isSafeLabel(raw.source, 64)) {
    throw invalidResponse("summary.source has the wrong type");
  }
  const rows = raw.rows as number;
  const totalRows = raw.total_rows_available as number;
  if (rows > totalRows) {
    throw invalidResponse("summary.rows exceeds summary.total_rows_available");
  }
  if (!raw.truncated && rows !== totalRows) {
    throw invalidResponse("summary is not truncated but rows differ from total_rows_available");
  }
  const requestedCode = request.warehouse_code;
  if (requestedCode === undefined) {
    if (code !== null) {
      throw invalidResponse("summary names a warehouse that was not requested");
    }
  } else if (typeof code !== "string" || code.toUpperCase() !== requestedCode.toUpperCase()) {
    throw invalidResponse("summary warehouse does not match the request");
  }
  if (request.as_of !== undefined && raw.as_of !== request.as_of) {
    throw invalidResponse("summary date does not match the request");
  }
  return {
    kind: "stock",
    as_of: raw.as_of,
    warehouse_code: code,
    warehouse_name: name,
    rows,
    total_rows_available: totalRows,
    total_quantity: raw.total_quantity as string,
    total_quantity_all: raw.total_quantity_all as string,
    truncated: raw.truncated,
    row_cap: raw.row_cap as number,
    byte_cap: raw.byte_cap as number,
    source: raw.source,
    items_without_name: (raw.items_without_name as number | undefined) ?? 0,
    null_amounts: (raw.null_amounts as number | undefined) ?? 0,
  };
}

/** Validate a parsed 200 body into a `StockExport`. Pure; exported for tests. */
export function validateStockExportResponse(
  body: unknown,
  request: StockExportRequest = {},
): StockExport {
  if (!isPlainObject(body)) {
    throw invalidResponse("body is not a JSON object");
  }
  if (body.ok !== true) {
    throw invalidResponse("ok is not true");
  }
  const fileName = body.file_name;
  if (typeof fileName !== "string" || !SHEETS_FILE_NAME_RE.test(fileName)) {
    throw invalidResponse("file_name does not match the allowed pattern");
  }
  if (body.mime_type !== SHEETS_XLSX_MIME) {
    throw invalidResponse("mime_type is not the spreadsheet type");
  }
  const bytes = decodeStrictBase64(body.content_base64);
  if (!bytes) {
    throw invalidResponse("content_base64 is not valid Base64");
  }
  if (bytes.length > SHEETS_MAX_FILE_BYTES) {
    throw new SheetExportError("EXPORT_TOO_LARGE", "exported file exceeds the size cap");
  }
  if (!hasZipSignature(bytes)) {
    throw invalidResponse("file is not an .xlsx (zip signature missing)");
  }
  const summary = validateStockExportSummary(body.summary, request);
  return {
    fileName,
    mimeType: SHEETS_XLSX_MIME,
    contentBase64: body.content_base64 as string,
    byteLength: bytes.length,
    summary,
  };
}

/** Validate and normalise the request body sent to the sidecar. */
export function buildStockExportRequestBody(request: StockExportRequest): Record<string, string> {
  const body: Record<string, string> = {};
  if (request.warehouse_code !== undefined) {
    if (typeof request.warehouse_code !== "string" || !SHEETS_WAREHOUSE_CODE_RE.test(request.warehouse_code)) {
      throw new SheetExportError("EXPORT_INVALID_REQUEST", "warehouse_code is not valid");
    }
    body.warehouse_code = request.warehouse_code;
  }
  if (request.as_of !== undefined) {
    if (!isValidIsoDate(request.as_of)) {
      throw new SheetExportError("EXPORT_INVALID_REQUEST", "as_of is not a YYYY-MM-DD date");
    }
    body.as_of = request.as_of;
  }
  if (request.lang !== undefined) {
    if (request.lang !== "en" && request.lang !== "ka") {
      throw new SheetExportError("EXPORT_INVALID_REQUEST", "lang must be en or ka");
    }
    body.lang = request.lang;
  }
  return body;
}

class BodyTooLargeError extends Error {}

/** Read at most `cap` bytes of a response body; throws `BodyTooLargeError` beyond it. */
async function readBodyCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > cap) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

/** The sidecar's `{ ok:false, code }` (or `{ error }` from the bearer gate), when safe. */
async function readUpstreamCode(response: Response): Promise<string | undefined> {
  try {
    const parsed = parseJsonBytes(await readBodyCapped(response, SHEETS_MAX_ERROR_BODY_BYTES));
    if (!isPlainObject(parsed)) {
      return undefined;
    }
    const candidate = typeof parsed.code === "string" ? parsed.code : parsed.error;
    return typeof candidate === "string" && UPSTREAM_CODE_RE.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a non-200 export response. The sidecar's own `code` decides first (on
 * any status), then the HTTP status. `upstreamCode` has already passed the
 * safe-token pattern; an unsafe code counts as no code.
 */
function errorForStatus(status: number, upstreamCode: string | undefined): SheetExportError {
  const extra = { status, ...(upstreamCode ? { upstreamCode } : {}) };
  const tooLarge = "the export is too large for one sheet; ask for one warehouse";
  switch (upstreamCode) {
    case "TOO_LARGE":
      return new SheetExportError("EXPORT_TOO_LARGE", tooLarge, extra);
    case "UNKNOWN_WAREHOUSE":
      return new SheetExportError("EXPORT_NOT_FOUND", "no warehouse has that code", extra);
    case "NAMES_UNAVAILABLE":
      return new SheetExportError(
        "EXPORT_NAMES_UNAVAILABLE",
        "item names are not loaded on the export service; ask the operator",
        extra,
      );
    case "NOT_CONFIGURED":
      return new SheetExportError("EXPORT_NOT_CONFIGURED", "export service is not configured", extra);
    default:
      break;
  }
  if (status === 413) {
    return new SheetExportError("EXPORT_TOO_LARGE", tooLarge, extra);
  }
  if (status === 503) {
    return new SheetExportError("EXPORT_UNAVAILABLE", "export service is unavailable right now", extra);
  }
  if (status === 504) {
    return new SheetExportError("EXPORT_TIMEOUT", "export service timed out reading the data", extra);
  }
  if (status === 401 || status === 403) {
    return new SheetExportError("EXPORT_UNAUTHORIZED", "export service refused the credentials", extra);
  }
  if (status === 400 || status === 405 || status === 422) {
    return new SheetExportError("EXPORT_BAD_REQUEST", "export service rejected the request", extra);
  }
  // Includes a 404 with any other code, or none: not a known missing warehouse.
  return new SheetExportError("EXPORT_UPSTREAM_ERROR", "export service failed", extra);
}

export type FetchStockExportParams = {
  request: StockExportRequest;
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the Node 22 global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. Defaults to `SHEETS_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * POST the pinned export URL and return a validated `.xlsx`.
 * Throws `SheetExportError` for every failure; never logs.
 */
export async function fetchStockExport(params: FetchStockExportParams): Promise<StockExport> {
  const token = readSheetsExportToken(params.env ?? process.env);
  if (!token) {
    throw new SheetExportError("EXPORT_NOT_CONFIGURED", "export service not configured");
  }
  const requestBody = buildStockExportRequestBody(params.request);
  const doFetch = params.fetchImpl ?? globalThis.fetch;
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? SHEETS_FETCH_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  const failure = (cause: unknown): SheetExportError => {
    if (cause instanceof SheetExportError) {
      return cause;
    }
    if (cause instanceof BodyTooLargeError) {
      return new SheetExportError("EXPORT_TOO_LARGE", "export response exceeds the size cap");
    }
    if (params.signal?.aborted) {
      return new SheetExportError("EXPORT_ABORTED", "export request aborted");
    }
    if (timeoutSignal.aborted) {
      return new SheetExportError("EXPORT_TIMEOUT", "export service did not answer in time");
    }
    // Deliberately not the raw error: it can carry the URL.
    return new SheetExportError("EXPORT_UNREACHABLE", "export service is unreachable");
  };

  let response: Response;
  try {
    response = await doFetch(SHEETS_STOCK_EXPORT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
      redirect: "error",
    });
  } catch (cause) {
    throw failure(cause);
  }

  if (response.status !== 200) {
    const upstreamCode = await readUpstreamCode(response);
    throw errorForStatus(response.status, upstreamCode);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(response, SHEETS_MAX_RESPONSE_BYTES);
  } catch (cause) {
    throw failure(cause);
  }
  let body: unknown;
  try {
    body = parseJsonBytes(bytes);
  } catch {
    // SyntaxError, or TypeError for invalid UTF-8 from the fatal decoder.
    throw invalidResponse("body is not JSON");
  }
  return validateStockExportResponse(body, params.request);
}
