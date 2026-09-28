// The export sidecar fetch: pinned URL, bearer from env, size caps and strict
// validation of every response field. All offline: `fetch` is a stub.

import { describe, expect, it, vi } from "vitest";
import {
  SHEETS_MAX_FILE_BYTES,
  SHEETS_MAX_RESPONSE_BYTES,
  SHEETS_STOCK_EXPORT_URL,
  SHEETS_TOKEN_ENV,
  SHEETS_XLSX_MIME,
  SheetExportError,
  decodeStrictBase64,
  fetchStockExport,
  isValidIsoDate,
  readSheetsExportToken,
  validateStockExportResponse,
  validateStockExportSummary,
  type StockExportRequest,
} from "../src/sheets.js";

const TOKEN = "synthetic-export-token-0123456789abcdef";
const ENV = { [SHEETS_TOKEN_ENV]: TOKEN } as NodeJS.ProcessEnv;
const XLSX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic workbook")]);

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "stock",
    as_of: "2026-01-15",
    warehouse_code: null,
    warehouse_name: null,
    rows: 2700,
    total_rows_available: 2700,
    total_quantity: "12345.678",
    total_quantity_all: "12345.678",
    truncated: false,
    row_cap: 20000,
    byte_cap: 5242880,
    source: "1C copy",
    ...overrides,
  };
}

function exportBody(
  overrides: Record<string, unknown> = {},
  summaryOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    file_name: "stock-all-2026-01-15.xlsx",
    mime_type: SHEETS_XLSX_MIME,
    content_base64: XLSX_BYTES.toString("base64"),
    summary: summary(summaryOverrides),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type RecordedFetch = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: RecordedFetch[] = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return await respond();
  });
  return { impl: impl as unknown as typeof fetch, calls, spy: impl };
}

async function expectExportError(
  promise: Promise<unknown>,
  code: SheetExportError["code"],
): Promise<SheetExportError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SheetExportError);
  expect((caught as SheetExportError).code).toBe(code);
  return caught as SheetExportError;
}

function expectInvalid(body: unknown, request: StockExportRequest = {}, code = "EXPORT_INVALID_RESPONSE") {
  let caught: unknown;
  try {
    validateStockExportResponse(body, request);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SheetExportError);
  expect((caught as SheetExportError).code).toBe(code);
}

describe("pinned request", () => {
  it("POSTs the pinned loopback URL with the bearer, JSON body and redirect: error", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(exportBody({}, { warehouse_code: "WH-01" })));
    const result = await fetchStockExport({
      request: { warehouse_code: "WH-01", as_of: "2026-01-15", lang: "ka" },
      fetchImpl: impl,
      env: ENV,
    });
    expect(result.fileName).toBe("stock-all-2026-01-15.xlsx");
    expect(result.byteLength).toBe(XLSX_BYTES.length);
    expect(result.contentBase64).toBe(XLSX_BYTES.toString("base64"));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("http://127.0.0.1:8765/exports/stock");
    expect(SHEETS_STOCK_EXPORT_URL).toBe("http://127.0.0.1:8765/exports/stock");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      warehouse_code: "WH-01",
      as_of: "2026-01-15",
      lang: "ka",
    });
  });

  it("sends an empty JSON object when no option is given", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(exportBody()));
    await fetchStockExport({ request: {}, fetchImpl: impl, env: ENV });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
  });

  it("refuses an invalid request before any fetch", async () => {
    const { impl, spy } = fakeFetch(() => jsonResponse(exportBody()));
    await expectExportError(
      fetchStockExport({ request: { warehouse_code: "../etc" }, fetchImpl: impl, env: ENV }),
      "EXPORT_INVALID_REQUEST",
    );
    await expectExportError(
      fetchStockExport({ request: { as_of: "2026-02-30" }, fetchImpl: impl, env: ENV }),
      "EXPORT_INVALID_REQUEST",
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("token", () => {
  it.each([
    ["missing", {}],
    ["empty", { [SHEETS_TOKEN_ENV]: "" }],
    ["31 characters", { [SHEETS_TOKEN_ENV]: "x".repeat(31) }],
    ["containing whitespace", { [SHEETS_TOKEN_ENV]: `${"x".repeat(20)} ${"y".repeat(20)}` }],
  ])("refuses when the token is %s, before any fetch", async (_label, env) => {
    const { impl, spy } = fakeFetch(() => jsonResponse(exportBody()));
    const error = await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: env as NodeJS.ProcessEnv }),
      "EXPORT_NOT_CONFIGURED",
    );
    expect(error.message).toBe("export service not configured");
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a 32-character token", () => {
    expect(readSheetsExportToken({ [SHEETS_TOKEN_ENV]: "x".repeat(32) } as NodeJS.ProcessEnv)).toBe(
      "x".repeat(32),
    );
  });
});

describe("HTTP status mapping (the sidecar's code first, then the status)", () => {
  const TOO_LARGE_TEXT = "the export is too large for one sheet; ask for one warehouse";
  it.each([
    // By the sidecar's own code, on any status.
    [413, { ok: false, code: "TOO_LARGE" }, "EXPORT_TOO_LARGE", "TOO_LARGE", TOO_LARGE_TEXT],
    [400, { ok: false, code: "TOO_LARGE" }, "EXPORT_TOO_LARGE", "TOO_LARGE", TOO_LARGE_TEXT],
    [500, { ok: false, code: "TOO_LARGE" }, "EXPORT_TOO_LARGE", "TOO_LARGE", TOO_LARGE_TEXT],
    [404, { ok: false, code: "UNKNOWN_WAREHOUSE" }, "EXPORT_NOT_FOUND", "UNKNOWN_WAREHOUSE", "no warehouse has that code"],
    [
      503,
      { ok: false, code: "NAMES_UNAVAILABLE" },
      "EXPORT_NAMES_UNAVAILABLE",
      "NAMES_UNAVAILABLE",
      "item names are not loaded on the export service; ask the operator",
    ],
    [503, { ok: false, code: "NOT_CONFIGURED" }, "EXPORT_NOT_CONFIGURED", "NOT_CONFIGURED", "export service is not configured"],
    // By status, when the code is unknown or missing.
    [413, {}, "EXPORT_TOO_LARGE", undefined, TOO_LARGE_TEXT],
    [404, { ok: false, code: "WAREHOUSE_NOT_FOUND" }, "EXPORT_UPSTREAM_ERROR", "WAREHOUSE_NOT_FOUND", "export service failed"],
    [404, {}, "EXPORT_UPSTREAM_ERROR", undefined, "export service failed"],
    [503, { ok: false, code: "BUSY" }, "EXPORT_UNAVAILABLE", "BUSY", "export service is unavailable right now"],
    [503, {}, "EXPORT_UNAVAILABLE", undefined, "export service is unavailable right now"],
    [504, { ok: false, code: "UPSTREAM_TIMEOUT" }, "EXPORT_TIMEOUT", "UPSTREAM_TIMEOUT", "export service timed out reading the data"],
    [401, { error: "unauthorized", detail: "bearer token required" }, "EXPORT_UNAUTHORIZED", "unauthorized", "export service refused the credentials"],
    [403, {}, "EXPORT_UNAUTHORIZED", undefined, "export service refused the credentials"],
    [400, { ok: false, code: "BAD_WAREHOUSE_CODE" }, "EXPORT_BAD_REQUEST", "BAD_WAREHOUSE_CODE", "export service rejected the request"],
    [405, { ok: false, code: "METHOD_NOT_ALLOWED" }, "EXPORT_BAD_REQUEST", "METHOD_NOT_ALLOWED", "export service rejected the request"],
    [422, { detail: [] }, "EXPORT_BAD_REQUEST", undefined, "export service rejected the request"],
    [500, { ok: false, code: "INTERNAL" }, "EXPORT_UPSTREAM_ERROR", "INTERNAL", "export service failed"],
    [502, { ok: false, code: "UPSTREAM_1C_ERROR" }, "EXPORT_UPSTREAM_ERROR", "UPSTREAM_1C_ERROR", "export service failed"],
    [418, {}, "EXPORT_UPSTREAM_ERROR", undefined, "export service failed"],
  ] as const)("maps HTTP %i %j to %s", async (status, body, code, upstream, message) => {
    const { impl } = fakeFetch(() => jsonResponse(body, status));
    const error = await expectExportError(fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }), code);
    expect(error.status).toBe(status);
    expect(error.upstreamCode).toBe(upstream);
    expect(error.message).toBe(message);
    expect(error.message).not.toMatch(/[\u2013\u2014]/);
  });

  it("drops an upstream code that is not a safe token", async () => {
    const { impl } = fakeFetch(() => jsonResponse({ ok: false, code: "bad code <script>" }, 500));
    const error = await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }),
      "EXPORT_UPSTREAM_ERROR",
    );
    expect(error.upstreamCode).toBeUndefined();
  });

  it("an unsafe code is not mapped by name either: the status decides", async () => {
    const { impl } = fakeFetch(() => jsonResponse({ ok: false, code: "NAMES_UNAVAILABLE\n" }, 503));
    const error = await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }),
      "EXPORT_UNAVAILABLE",
    );
    expect(error.upstreamCode).toBeUndefined();
  });

  it("maps a non-JSON error body without failing on it", async () => {
    const { impl } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expectExportError(fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }), "EXPORT_UPSTREAM_ERROR");
    const { impl: tooLarge } = fakeFetch(() => new Response("<html>entity too large</html>", { status: 413 }));
    await expectExportError(fetchStockExport({ request: {}, fetchImpl: tooLarge, env: ENV }), "EXPORT_TOO_LARGE");
  });
});

describe("transport failures", () => {
  it("times out", async () => {
    const impl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: ENV, timeoutMs: 20 }),
      "EXPORT_TIMEOUT",
    );
  });

  it("reports an unreachable sidecar without the raw error (which names the URL)", async () => {
    const impl = (async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${SHEETS_STOCK_EXPORT_URL}`);
    }) as unknown as typeof fetch;
    const error = await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }),
      "EXPORT_UNREACHABLE",
    );
    expect(`${error.message} ${error.stack ?? ""}`).not.toContain("127.0.0.1");
  });

  it("honours the caller's abort signal", async () => {
    const controller = new AbortController();
    const impl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        controller.abort();
      })) as unknown as typeof fetch;
    await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: ENV, signal: controller.signal }),
      "EXPORT_ABORTED",
    );
  });

  it("never puts the token in an error", async () => {
    const impl = (async () => {
      throw new Error(`boom Bearer ${TOKEN}`);
    }) as unknown as typeof fetch;
    const error = await expectExportError(
      fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }),
      "EXPORT_UNREACHABLE",
    );
    expect(JSON.stringify({ ...error, message: error.message, stack: error.stack })).not.toContain(TOKEN);
  });
});

describe("response size cap (checked before JSON parsing)", () => {
  it("rejects a declared content-length over the cap", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(SHEETS_MAX_RESPONSE_BYTES + 1) },
        }),
    );
    await expectExportError(fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }), "EXPORT_TOO_LARGE");
  });

  it("rejects a streamed body that grows past the cap", async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const { impl } = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              sent += 1;
              if (sent > 64) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    await expectExportError(fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }), "EXPORT_TOO_LARGE");
    // Reading stopped shortly after the 7.5 MiB cap; the 64 MiB stream was not drained.
    expect(sent).toBeLessThan(20);
  });
});

describe("response validation", () => {
  it("rejects a body that is not JSON", async () => {
    const { impl } = fakeFetch(() => new Response("PK\u0003\u0004 not json", { status: 200 }));
    await expectExportError(fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }), "EXPORT_INVALID_RESPONSE");
  });

  it("rejects invalid UTF-8", async () => {
    const { impl } = fakeFetch(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }));
    await expectExportError(fetchStockExport({ request: {}, fetchImpl: impl, env: ENV }), "EXPORT_INVALID_RESPONSE");
  });

  it("rejects a non-object body and ok !== true", () => {
    expectInvalid([exportBody()]);
    expectInvalid("ok");
    expectInvalid(exportBody({ ok: false }));
    expectInvalid(exportBody({ ok: "true" }));
    expectInvalid({ ok: false, code: "INTERNAL", message: "x" });
  });

  it.each([
    "../stock.xlsx",
    "dir/stock.xlsx",
    "dir\\stock.xlsx",
    "stock.xls",
    "stock.xlsx.exe",
    "stock .xlsx",
    ".hidden.xlsx",
    ".xlsx",
    "ნაშთი.xlsx",
    `${"a".repeat(121)}.xlsx`,
    "",
    42,
  ])("rejects file name %s", (fileName) => {
    expectInvalid(exportBody({ file_name: fileName }));
  });

  it("accepts a 120-character file name", () => {
    expect(validateStockExportResponse(exportBody({ file_name: `${"a".repeat(120)}.xlsx` })).fileName).toHaveLength(125);
  });

  it.each([
    "application/zip",
    "application/octet-stream",
    `${SHEETS_XLSX_MIME}; charset=utf-8`,
    undefined,
  ])("rejects mime type %s", (mime) => {
    expectInvalid(exportBody({ mime_type: mime }));
  });

  it.each([
    ["not base64", "not base64!"],
    ["bad length", "UEsDBA"],
    ["embedded newline", `${XLSX_BYTES.toString("base64").slice(0, 8)}\n${XLSX_BYTES.toString("base64").slice(8)}`],
    ["url-safe alphabet", "UEsDBP__"],
    ["non-canonical padding bits", "UEsDBB=="],
    ["empty", ""],
    ["a number", 12345],
  ])("rejects content_base64: %s", (_label, content) => {
    expectInvalid(exportBody({ content_base64: content }));
  });

  it("rejects bytes without the PK\\x03\\x04 signature", () => {
    expectInvalid(exportBody({ content_base64: Buffer.from("PK\u0005\u0006 end record").toString("base64") }));
    expectInvalid(exportBody({ content_base64: Buffer.from("%PDF-1.7").toString("base64") }));
  });

  it("rejects a decoded file over 5 MiB", () => {
    const big = Buffer.alloc(SHEETS_MAX_FILE_BYTES + 1, 0x41);
    big.set([0x50, 0x4b, 0x03, 0x04], 0);
    expectInvalid(exportBody({ content_base64: big.toString("base64") }), {}, "EXPORT_TOO_LARGE");
  });

  it("accepts exactly 5 MiB", () => {
    const max = Buffer.alloc(SHEETS_MAX_FILE_BYTES, 0x41);
    max.set([0x50, 0x4b, 0x03, 0x04], 0);
    expect(validateStockExportResponse(exportBody({ content_base64: max.toString("base64") })).byteLength).toBe(
      SHEETS_MAX_FILE_BYTES,
    );
  });

  it("strict Base64 decoding", () => {
    expect(decodeStrictBase64("UEsDBA==")?.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(decodeStrictBase64("UEsDBB==")).toBeUndefined();
    expect(decodeStrictBase64("UEsD BA=")).toBeUndefined();
  });
});

describe("summary validation (exact types)", () => {
  it("accepts the contract shape", () => {
    const counters = { items_without_name: 0, null_amounts: 0 };
    expect(validateStockExportSummary(summary())).toEqual({ ...summary(), ...counters });
    const withWarehouse = summary({ warehouse_code: "WH-01", warehouse_name: "მთავარი საწყობი" });
    expect(validateStockExportSummary(withWarehouse, { warehouse_code: "WH-01" })).toEqual({
      ...withWarehouse,
      ...counters,
    });
    // The server may normalise the case of the code.
    expect(
      validateStockExportSummary(summary({ warehouse_code: "WH-01" }), { warehouse_code: "wh-01" }).warehouse_code,
    ).toBe("WH-01");
    const truncated = summary({ rows: 20000, total_rows_available: 23000, truncated: true });
    expect(validateStockExportSummary(truncated)).toEqual({ ...truncated, ...counters });
  });

  it("items_without_name and null_amounts are optional non-negative integers (0 when absent)", () => {
    const withCounters = summary({ items_without_name: 12, null_amounts: 3 });
    expect(validateStockExportSummary(withCounters)).toEqual(withCounters);
    expect(validateStockExportSummary(summary({ items_without_name: 5 }))).toMatchObject({
      items_without_name: 5,
      null_amounts: 0,
    });
    expect(validateStockExportSummary(summary({ null_amounts: 0 }))).toMatchObject({
      items_without_name: 0,
      null_amounts: 0,
    });
  });

  it.each([
    ["items_without_name", -1],
    ["items_without_name", 1.5],
    ["items_without_name", "3"],
    ["items_without_name", null],
    ["items_without_name", true],
    ["null_amounts", -2],
    ["null_amounts", Number.NaN],
    ["null_amounts", "0"],
    ["null_amounts", null],
  ])("rejects summary.%s = %j", (key, value) => {
    expectInvalid(exportBody({}, { [key]: value }));
  });

  it("the summary date must equal the requested as_of", () => {
    expect(validateStockExportSummary(summary(), { as_of: "2026-01-15" }).as_of).toBe("2026-01-15");
    let caught: unknown;
    try {
      validateStockExportSummary(summary(), { as_of: "2025-12-31" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SheetExportError);
    expect((caught as SheetExportError).code).toBe("EXPORT_INVALID_RESPONSE");
    expect((caught as SheetExportError).message).toBe(
      "export response rejected: summary date does not match the request",
    );
    // Without an as_of in the request, the server's date (today) is accepted.
    expect(validateStockExportSummary(summary({ as_of: "2026-09-28" })).as_of).toBe("2026-09-28");
  });

  it("fetchStockExport refuses a file for another date than requested", async () => {
    const { impl } = fakeFetch(() => jsonResponse(exportBody({}, { as_of: "2026-01-15" })));
    await expectExportError(
      fetchStockExport({ request: { as_of: "2026-01-14" }, fetchImpl: impl, env: ENV }),
      "EXPORT_INVALID_RESPONSE",
    );
  });

  it.each([
    ["summary missing", undefined],
    ["summary an array", []],
  ])("rejects %s", (_label, value) => {
    expectInvalid(exportBody({ summary: value }));
  });

  it.each([
    ["kind", "sales"],
    ["as_of", "2026-13-01"],
    ["as_of", "2026-02-30"],
    ["as_of", "15.01.2026"],
    ["as_of", null],
    ["warehouse_code", 5],
    ["warehouse_code", "WH 01"],
    ["warehouse_code", ""],
    ["warehouse_name", 7],
    ["warehouse_name", "line\nbreak"],
    ["warehouse_name", "x".repeat(201)],
    ["rows", "2700"],
    ["rows", -1],
    ["rows", 1.5],
    ["rows", null],
    ["total_rows_available", "2700"],
    ["row_cap", undefined],
    ["byte_cap", 1.25],
    ["total_quantity", 12345.678],
    ["total_quantity", "1e5"],
    ["total_quantity", "12,345.678"],
    ["total_quantity", ""],
    ["total_quantity_all", null],
    ["truncated", "false"],
    ["truncated", 0],
    ["source", undefined],
    ["source", ""],
    ["source", "x".repeat(65)],
  ])("rejects summary.%s = %j", (key, value) => {
    expectInvalid(exportBody({}, { [key]: value }));
  });

  it("rejects inconsistent row counts", () => {
    expectInvalid(exportBody({}, { rows: 3000, total_rows_available: 2700, truncated: true }));
    expectInvalid(exportBody({}, { rows: 2000, total_rows_available: 2700, truncated: false }));
  });

  it("rejects a file for a different warehouse than requested", () => {
    expectInvalid(exportBody({}, { warehouse_code: "WH-02" }), { warehouse_code: "WH-01" });
    expectInvalid(exportBody({}, { warehouse_code: null }), { warehouse_code: "WH-01" });
    expectInvalid(exportBody({}, { warehouse_code: "WH-01" }), {});
  });
});

describe("isValidIsoDate", () => {
  it("accepts real dates only", () => {
    expect(isValidIsoDate("2026-01-15")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-1-15")).toBe(false);
    expect(isValidIsoDate(20260115)).toBe(false);
  });
});
