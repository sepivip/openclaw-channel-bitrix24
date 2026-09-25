// `bitrix24_send_sheet`: target, agent and config gates, the export-then-upload
// flow, captions, failure honesty, log hygiene, registration, and the loop
// guard for the bot's own file message (F18).
//
// Offline: the sidecar is a stub `fetch`, Bitrix is a recording fake client.
// `runChannelInboundEvent` is mocked (as in groups.test.ts) so the inbound
// path can be driven to prove what core would receive, and that a bot file
// message never dispatches.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

type CapturedTurn = { plan: { ctxPayload: Record<string, unknown> } };
const harness = vi.hoisted(() => ({ turns: [] as CapturedTurn[] }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (input: unknown, eventClass: unknown, preflight: unknown) => Promise<unknown>;
      };
    }) => {
      const input = await params.adapter.ingest(params.raw);
      const plan = (await params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      )) as CapturedTurn["plan"] & { route: { sessionKey: string } };
      harness.turns.push({ plan });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {},
      };
    },
  };
});

import type { Bitrix24Client } from "../src/client.js";
import { resetBitrix24ConfigNotices } from "../src/config-schema.js";
import { handleBitrix24InboundEvent, type Bitrix24RawEvent } from "../src/inbound.js";
import { Bitrix24Error } from "../src/secrets.js";
import { SHEETS_TOKEN_ENV, SHEETS_XLSX_MIME } from "../src/sheets.js";
import {
  BITRIX24_SEND_SHEET_TOOL_NAME,
  bitrix24SendSheetParameters,
  buildStockSheetCaption,
  createBitrix24SendSheetTool,
  resolveBitrix24RouteAgentId,
  runBitrix24SendSheet,
  validateSendSheetArgs,
  type SendSheetResult,
} from "../src/tools.js";
import {
  AGENT_ID,
  BOT_ID,
  LISTED_GROUP,
  OUTSIDER,
  OWNER,
  STAFF,
  UNLISTED_GROUP,
  buildConfig,
  buildDeps,
  captureLog,
  mention,
  realShapeDmEvent,
  realShapeGroupEvent,
} from "./fixtures.js";

const EXPORT_TOKEN = "synthetic-export-token-0123456789abcdef";
const BOT_TOKEN = "fake-bot-token";
const ENV = { [SHEETS_TOKEN_ENV]: EXPORT_TOKEN } as NodeJS.ProcessEnv;
const XLSX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic workbook")]);
const XLSX_BASE64 = XLSX_BYTES.toString("base64");
const DM = String(OWNER);

/** Strings that must never appear in a log line, a console line or a tool result. */
const FORBIDDEN = [EXPORT_TOKEN, BOT_TOKEN, "fakefakefake", "127.0.0.1", "8765", "exports/stock", XLSX_BASE64];

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

function exportBody(summaryOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    file_name: "stock-all-2026-01-15.xlsx",
    mime_type: SHEETS_XLSX_MIME,
    content_base64: XLSX_BASE64,
    summary: summary(summaryOverrides),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type UploadCall = { method: string; params: Record<string, unknown>; options: unknown };

type SetupOptions = {
  cfg?: never;
  context?: Partial<OpenClawPluginToolContext>;
  /** Replace the whole context (for "no deliveryContext" style cases). */
  rawContext?: OpenClawPluginToolContext;
  exportResponse?: () => Response | Promise<Response>;
  upload?: (params: Record<string, unknown>) => unknown;
  running?: boolean;
  env?: NodeJS.ProcessEnv;
};

function setup(opts: SetupOptions = {}) {
  const cfg = opts.cfg ?? buildConfig();
  const uploads: UploadCall[] = [];
  const client: Bitrix24Client = {
    call: (async (method: string, params?: Record<string, unknown>, options?: unknown) => {
      uploads.push({ method, params: params ?? {}, options });
      return opts.upload ? opts.upload(params ?? {}) : { file: { id: 138 }, messageId: 777, dialogId: params?.dialogId };
    }) as Bitrix24Client["call"],
    describe: () => ({ host: "synthetic.bitrix24.test", userId: "7" }),
  };
  const fetchImpl = vi.fn(async () => await (opts.exportResponse ?? (() => jsonResponse(exportBody())))());
  const log = captureLog();
  const context: OpenClawPluginToolContext = opts.rawContext ?? {
    agentId: AGENT_ID,
    sessionKey: `agent:${AGENT_ID}:main`,
    agentAccountId: "default",
    deliveryContext: { channel: "bitrix24", to: DM, accountId: "default" },
    requesterSenderId: DM,
    getRuntimeConfig: () => cfg,
    ...opts.context,
  };
  const getAccountRuntime = vi.fn((accountId: string) =>
    opts.running === false || accountId !== "default" ? undefined : { client, botId: BOT_ID, botToken: BOT_TOKEN },
  );
  const deps = {
    context,
    getAccountRuntime,
    log,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: opts.env ?? ENV,
  };
  return {
    deps,
    uploads,
    fetchImpl,
    log,
    run: (args: unknown = { kind: "stock" }) => runBitrix24SendSheet(deps, args),
  };
}

function expectRefused(result: SendSheetResult, code: string) {
  expect(result.ok).toBe(false);
  expect(result).toMatchObject({ ok: false, error_code: code });
  expect(result).not.toHaveProperty("message_id");
}

function expectCleanLogs(log: ReturnType<typeof captureLog>, extra: string[] = []) {
  const all = [...log.all(), ...extra].join("\n");
  for (const secret of FORBIDDEN) {
    expect(all).not.toContain(secret);
  }
}

let consoleLines: string[] = [];
beforeEach(() => {
  harness.turns.length = 0;
  resetBitrix24ConfigNotices();
  consoleLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

describe("tool schema", () => {
  it("accepts kind, warehouse_code, as_of and lang only, and no target", () => {
    expect(bitrix24SendSheetParameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["kind"],
    });
    expect(Object.keys(bitrix24SendSheetParameters.properties).sort()).toEqual(
      ["as_of", "kind", "lang", "warehouse_code"],
    );
    expect(bitrix24SendSheetParameters.properties.kind.enum).toEqual(["stock"]);
    expect(bitrix24SendSheetParameters.properties.lang.enum).toEqual(["en", "ka"]);
    expect(bitrix24SendSheetParameters.properties.warehouse_code.pattern).toBe("^[A-Za-z0-9-]{1,32}$");
    expect(bitrix24SendSheetParameters.properties.as_of.pattern).toBe("^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
  });

  it("the concrete tool carries that schema and returns text + details", async () => {
    const { deps } = setup();
    const tool = createBitrix24SendSheetTool(deps);
    expect(tool.name).toBe("bitrix24_send_sheet");
    expect(tool.parameters).toBe(bitrix24SendSheetParameters);
    const result = await tool.execute("call-1", { kind: "stock" });
    expect(result.details).toMatchObject({ ok: true });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
  });
});

describe("argument re-validation (hub condition 5)", () => {
  it.each(["dialogId", "chatId", "to", "target", "chat", "dialog_id", "DialogId", "userId", "recipient", "accountId"])(
    "refuses a %s argument and never uses it",
    async (key) => {
      const { run, uploads, fetchImpl } = setup();
      const result = await run({ kind: "stock", [key]: UNLISTED_GROUP });
      expectRefused(result, "TARGET_NOT_ALLOWED");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(uploads).toHaveLength(0);
    },
  );

  it.each([
    ["an unknown key", { kind: "stock", rows: 5 }],
    ["a missing kind", {}],
    ["another kind", { kind: "sales" }],
    ["a bad warehouse code", { kind: "stock", warehouse_code: "../x" }],
    ["a null warehouse code", { kind: "stock", warehouse_code: null }],
    ["an impossible date", { kind: "stock", as_of: "2026-02-30" }],
    ["another language", { kind: "stock", lang: "ru" }],
    ["an array", [{ kind: "stock" }]],
    ["a string", "stock"],
    ["null", null],
  ])("refuses %s", async (_label, args) => {
    const { run, uploads, fetchImpl } = setup();
    expectRefused(await run(args), "INVALID_ARGUMENTS");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("accepts the four declared keys", () => {
    expect(validateSendSheetArgs({ kind: "stock", warehouse_code: "WH-01", as_of: "2026-01-15", lang: "ka" })).toEqual({
      kind: "stock",
      warehouse_code: "WH-01",
      as_of: "2026-01-15",
      lang: "ka",
    });
  });
});

describe("happy path", () => {
  it("DM: exports, uploads into the DM and returns the server numbers", async () => {
    const { run, uploads, fetchImpl, log } = setup();
    const result = await run({ kind: "stock", lang: "en" });

    expect(result).toEqual({
      ok: true,
      file_name: "stock-all-2026-01-15.xlsx",
      rows: 2700,
      total_rows_available: 2700,
      total_quantity: "12345.678",
      total_quantity_all: "12345.678",
      as_of: "2026-01-15",
      warehouse_code: null,
      warehouse_name: null,
      truncated: false,
      message_id: "777",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    const upload = uploads[0] as UploadCall;
    expect(upload.method).toBe("imbot.v2.File.upload");
    expect(upload.params).toEqual({
      botId: BOT_ID,
      botToken: BOT_TOKEN,
      dialogId: DM,
      fields: {
        name: "stock-all-2026-01-15.xlsx",
        content: XLSX_BASE64,
        message:
          "Stock across all warehouses as of 2026-01-15: 2700 lines, total quantity 12345.678. Source: 1C copy.",
      },
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      `[bitrix24] sheet sent kind=stock dialog=${DM} rows=2700 bytes=${XLSX_BYTES.length} ` +
        "file=stock-all-2026-01-15.xlsx messageId=777",
    );
    expect(log.warn).not.toHaveBeenCalled();
    expectCleanLogs(log, [...consoleLines, JSON.stringify(result)]);
  });

  it("group: uploads into the listed chat the turn came from", async () => {
    const { run, uploads } = setup({
      context: {
        deliveryContext: { channel: "bitrix24", to: LISTED_GROUP, accountId: "default" },
        requesterSenderId: String(STAFF),
        sessionKey: `agent:${AGENT_ID}:bitrix24:group:${LISTED_GROUP}`,
      },
      exportResponse: () =>
        jsonResponse(exportBody({ warehouse_code: "WH-01", warehouse_name: "Main" })),
    });
    const result = await run({ kind: "stock", warehouse_code: "WH-01" });
    expect(result).toMatchObject({ ok: true, warehouse_code: "WH-01", warehouse_name: "Main" });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.params.dialogId).toBe(LISTED_GROUP);
  });

  it("the target comes only from deliveryContext, never from the session key or native id", async () => {
    const { run, uploads } = setup({
      context: {
        sessionKey: `agent:${AGENT_ID}:bitrix24:group:${LISTED_GROUP}`,
        nativeChannelId: UNLISTED_GROUP,
        deliveryContext: { channel: "bitrix24", to: DM, accountId: "default" },
      },
    });
    expect((await run()).ok).toBe(true);
    expect(uploads.map((u) => u.params.dialogId)).toEqual([DM]);
  });

  it("forwards warehouse_code, as_of and lang to the sidecar", async () => {
    const { run, fetchImpl } = setup({
      exportResponse: () => jsonResponse(exportBody({ warehouse_code: "WH-01", as_of: "2025-12-31" })),
    });
    await run({ kind: "stock", warehouse_code: "WH-01", as_of: "2025-12-31", lang: "ka" });
    const init = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init[1].body))).toEqual({ warehouse_code: "WH-01", as_of: "2025-12-31", lang: "ka" });
  });
});

describe("turn context gates (F16)", () => {
  it.each([
    ["no deliveryContext", { deliveryContext: undefined }],
    ["another channel", { deliveryContext: { channel: "telegram", to: DM } }],
    ["no channel", { deliveryContext: { to: DM } }],
  ])("refuses with %s, 0 exports, 0 uploads", async (_label, context) => {
    const { run, uploads, fetchImpl } = setup({ context: context as Partial<OpenClawPluginToolContext> });
    expectRefused(await run(), "NOT_A_BITRIX_TURN");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it.each(["bitrix24:4101", "user:4101", "chat", "chat12a", "chat-1", "", "4101;chat8801", "12345678901234567890123"])(
    "refuses a malformed target %j",
    async (to) => {
      const { run, uploads } = setup({ context: { deliveryContext: { channel: "bitrix24", to } } });
      expectRefused(await run(), "INVALID_TARGET");
      expect(uploads).toHaveLength(0);
    },
  );

  it("refuses another agent, 0 exports, 0 uploads", async () => {
    const { run, uploads, fetchImpl } = setup({ context: { agentId: "main" } });
    expectRefused(await run(), "AGENT_NOT_ALLOWED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("refuses when the agent id is missing", async () => {
    const { run, uploads } = setup({ context: { agentId: undefined } });
    expectRefused(await run(), "AGENT_NOT_ALLOWED");
    expect(uploads).toHaveLength(0);
  });

  it("refuses an unknown account", async () => {
    const { run, uploads } = setup({
      context: { deliveryContext: { channel: "bitrix24", to: DM, accountId: "other" }, agentAccountId: "other" },
    });
    expectRefused(await run(), "UNKNOWN_ACCOUNT");
    expect(uploads).toHaveLength(0);
  });

  it("refuses when the delivery and agent accounts disagree", async () => {
    const { run } = setup({ context: { agentAccountId: "other" } });
    expectRefused(await run(), "UNKNOWN_ACCOUNT");
  });

  it("refuses without any config", async () => {
    const { run } = setup({
      context: { getRuntimeConfig: () => undefined, runtimeConfig: undefined, config: undefined },
    });
    expectRefused(await run(), "CONFIG_UNAVAILABLE");
  });
});

describe("agent resolution from bindings", () => {
  const route = (agentId: string, match: Record<string, unknown>, type?: string) => ({
    ...(type === undefined ? {} : { type }),
    agentId,
    match,
  });

  it("resolves the pilot shape (route, channel bitrix24, accountId *)", () => {
    const cfg = { bindings: [route(AGENT_ID, { channel: "bitrix24", accountId: "*" }, "route")] } as never;
    expect(resolveBitrix24RouteAgentId(cfg, "default")).toEqual({ ok: true, agentId: AGENT_ID });
  });

  it("an omitted accountId matches only the default account; an explicit one only itself", () => {
    const omitted = { bindings: [route(AGENT_ID, { channel: "bitrix24" })] } as never;
    expect(resolveBitrix24RouteAgentId(omitted, "default")).toEqual({ ok: true, agentId: AGENT_ID });
    expect(resolveBitrix24RouteAgentId(omitted, "other")).toEqual({ ok: false, reason: "no_binding" });
    const explicit = { bindings: [route(AGENT_ID, { channel: "bitrix24", accountId: "default" })] } as never;
    expect(resolveBitrix24RouteAgentId(explicit, "default")).toEqual({ ok: true, agentId: AGENT_ID });
    const otherAccount = { bindings: [route(AGENT_ID, { channel: "bitrix24", accountId: "sales" })] } as never;
    expect(resolveBitrix24RouteAgentId(otherAccount, "default")).toEqual({ ok: false, reason: "no_binding" });
  });

  it("ignores other channels and acp bindings", () => {
    const cfg = {
      bindings: [
        route("main", { channel: "telegram", accountId: "*" }),
        route("main", { channel: "bitrix24", accountId: "*" }, "acp"),
        route(AGENT_ID, { channel: "bitrix24", accountId: "*" }),
      ],
    } as never;
    expect(resolveBitrix24RouteAgentId(cfg, "default")).toEqual({ ok: true, agentId: AGENT_ID });
  });

  it("refuses when bindings name more than one agent (including peer-scoped ones)", () => {
    const cfg = {
      bindings: [
        route(AGENT_ID, { channel: "bitrix24", accountId: "*" }),
        route("main", { channel: "bitrix24", accountId: "*", peer: { kind: "direct", id: "4101" } }),
      ],
    } as never;
    expect(resolveBitrix24RouteAgentId(cfg, "default")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("refuses a matching binding without an agent id", () => {
    const cfg = { bindings: [{ type: "route", match: { channel: "bitrix24", accountId: "*" } }] } as never;
    expect(resolveBitrix24RouteAgentId(cfg, "default")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it.each([
    ["no bindings", {}],
    ["an empty list", { bindings: [] }],
    ["a non-array", { bindings: { channel: "bitrix24" } }],
  ])("the tool refuses with %s", async (_label, extra) => {
    const cfg = { ...(buildConfig() as object), bindings: undefined, ...extra } as never;
    const { run, uploads, fetchImpl } = setup({ cfg });
    expectRefused(await run(), "AGENT_NOT_RESOLVED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("the tool refuses when two agents are bound", async () => {
    const cfg = buildConfig({}, {
      bindings: [
        route(AGENT_ID, { channel: "bitrix24", accountId: "*" }, "route"),
        route("main", { channel: "bitrix24" }, "route"),
      ],
    });
    const { run, uploads } = setup({ cfg });
    expectRefused(await run(), "AGENT_NOT_RESOLVED");
    expect(uploads).toHaveLength(0);
  });
});

describe("live account config re-check (defence in depth)", () => {
  it("refuses a DM target that is not in allowFrom", async () => {
    const { run, uploads, fetchImpl } = setup({
      context: {
        deliveryContext: { channel: "bitrix24", to: String(OUTSIDER), accountId: "default" },
        requesterSenderId: String(OUTSIDER),
      },
    });
    expectRefused(await run(), "DM_TARGET_NOT_ALLOWED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("refuses a DM when dmPolicy is disabled", async () => {
    const { run, uploads } = setup({ cfg: buildConfig({ dmPolicy: "disabled" }) });
    expectRefused(await run(), "DM_TARGET_NOT_ALLOWED");
    expect(uploads).toHaveLength(0);
  });

  it("refuses an unlisted chat", async () => {
    const { run, uploads, fetchImpl } = setup({
      context: { deliveryContext: { channel: "bitrix24", to: UNLISTED_GROUP, accountId: "default" } },
    });
    expectRefused(await run(), "GROUP_TARGET_NOT_ALLOWED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("refuses a listed chat when groupPolicy is disabled", async () => {
    const { run, uploads } = setup({
      cfg: buildConfig({ groupPolicy: "disabled" }),
      context: { deliveryContext: { channel: "bitrix24", to: LISTED_GROUP, accountId: "default" } },
    });
    expectRefused(await run(), "GROUP_TARGET_NOT_ALLOWED");
    expect(uploads).toHaveLength(0);
  });

  it("refuses a group request from a sender outside allowFrom", async () => {
    const { run, uploads } = setup({
      context: {
        deliveryContext: { channel: "bitrix24", to: LISTED_GROUP, accountId: "default" },
        requesterSenderId: String(OUTSIDER),
      },
    });
    expectRefused(await run(), "SENDER_NOT_ALLOWED");
    expect(uploads).toHaveLength(0);
  });

  it("refuses a DM whose requester is not the DM owner", async () => {
    const { run, uploads } = setup({ context: { requesterSenderId: String(STAFF) } });
    expectRefused(await run(), "SENDER_NOT_ALLOWED");
    expect(uploads).toHaveLength(0);
  });

  it("refuses when the channel is disabled", async () => {
    const { run, uploads } = setup({ cfg: buildConfig({ enabled: false }) });
    expectRefused(await run(), "CHANNEL_UNAVAILABLE");
    expect(uploads).toHaveLength(0);
  });

  it("refuses when the account is not running", async () => {
    const { run, uploads, fetchImpl } = setup({ running: false });
    expectRefused(await run(), "ACCOUNT_NOT_RUNNING");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });
});

describe("export token", () => {
  it.each([
    ["missing", {}],
    ["short", { [SHEETS_TOKEN_ENV]: "x".repeat(31) }],
  ])("refuses when the token is %s: 0 exports, 0 uploads", async (_label, env) => {
    const { run, uploads, fetchImpl, log } = setup({ env: env as NodeJS.ProcessEnv });
    const result = await run();
    expectRefused(result, "EXPORT_NOT_CONFIGURED");
    expect(result).toMatchObject({ message: expect.stringContaining("export service not configured") });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("[bitrix24] sheet not sent code=EXPORT_NOT_CONFIGURED");
  });
});

describe("failures never claim success (F15)", () => {
  it.each([
    ["FILE_UPLOAD_FAILED", "FILE_UPLOAD_FAILED"],
    ["FILE_TOO_LARGE", "FILE_TOO_LARGE"],
    ["TRANSPORT_ERROR", "not confirmed"],
  ])("an upload failure (%s) is ok:false with one warning and no success line", async (code, text) => {
    const { run, uploads, log } = setup({
      upload: () => {
        throw new Bitrix24Error({ method: "imbot.v2.File.upload", code, description: "synthetic" });
      },
    });
    const result = await run();
    expectRefused(result, "UPLOAD_FAILED");
    expect((result as { message: string }).message).toContain(text);
    expect(uploads).toHaveLength(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("[bitrix24] sheet not sent code=UPLOAD_FAILED");
    expect(JSON.stringify(result)).not.toMatch(/"ok":true|sheet sent/);
    expectCleanLogs(log, [...consoleLines, JSON.stringify(result)]);
  });

  it("an unconfirmed upload (no file id, no message id) is a failure", async () => {
    const { run } = setup({ upload: () => ({}) });
    expectRefused(await run(), "UPLOAD_FAILED");
  });

  it.each([
    [500, "EXPORT_UPSTREAM_ERROR"],
    [504, "EXPORT_TIMEOUT"],
    [401, "EXPORT_UNAUTHORIZED"],
    [404, "EXPORT_NOT_FOUND"],
  ])("an export failure (HTTP %i) is %s and nothing is uploaded", async (status, code) => {
    const { run, uploads, log } = setup({
      exportResponse: () => jsonResponse({ ok: false, code: "SYNTHETIC", message: "x" }, status),
    });
    const result = await run();
    expectRefused(result, code);
    expect((result as { message: string }).message).toContain("not sent");
    expect(uploads).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(`[bitrix24] sheet not sent code=${code}`);
  });

  it("an invalid export response is refused and nothing is uploaded", async () => {
    const { run, uploads } = setup({
      exportResponse: () => jsonResponse(exportBody({}, { content_base64: Buffer.from("not a zip").toString("base64") })),
    });
    expectRefused(await run(), "EXPORT_INVALID_RESPONSE");
    expect(uploads).toHaveLength(0);
  });

  it("an unexpected exception becomes INTERNAL_ERROR, not a crash", async () => {
    const { deps } = setup();
    const result = await runBitrix24SendSheet(
      {
        ...deps,
        getAccountRuntime: () => {
          throw new Error(`boom ${BOT_TOKEN}`);
        },
      },
      { kind: "stock" },
    );
    expectRefused(result, "INTERNAL_ERROR");
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });
});

describe("caption and result carry the server numbers exactly (F20)", () => {
  const truncated = summary({
    warehouse_code: "WH-01",
    warehouse_name: "Main Store",
    rows: 20000,
    total_rows_available: 23241,
    total_quantity: "98765.4321",
    total_quantity_all: "123456.0005",
    truncated: true,
  });

  it("English, one warehouse, truncated", async () => {
    const { run, uploads } = setup({ exportResponse: () => jsonResponse(exportBody(truncated)) });
    const result = await run({ kind: "stock", warehouse_code: "WH-01", lang: "en" });
    const caption = (uploads[0]?.params.fields as { message: string }).message;
    expect(caption).toBe(
      "Stock at Main Store (WH-01) as of 2026-01-15: 20000 lines, total quantity 98765.4321. " +
        "Source: 1C copy. Truncated: 20000 of 23241 lines shown. Total quantity of all lines: 123456.0005.",
    );
    expect(result).toMatchObject({
      ok: true,
      rows: 20000,
      total_rows_available: 23241,
      total_quantity: "98765.4321",
      total_quantity_all: "123456.0005",
      truncated: true,
    });
    for (const text of [caption, JSON.stringify(result)]) {
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
    }
  });

  it("Georgian, one warehouse, truncated", () => {
    const caption = buildStockSheetCaption(truncated as never, "ka");
    expect(caption).toBe(
      "ნაშთი: Main Store (WH-01), 2026-01-15-ის მდგომარეობით: 20000 სტრიქონი, ჯამური რაოდენობა 98765.4321. " +
        "წყარო: 1C-ის ასლი. შეკვეცილია: ნაჩვენებია 20000 სტრიქონი 23241-დან. " +
        "ყველა სტრიქონის ჯამური რაოდენობა: 123456.0005.",
    );
    expect(caption).not.toContain("—");
  });

  it("all warehouses and a code without a name, both languages", () => {
    const all = summary();
    expect(buildStockSheetCaption(all as never, "en")).toBe(
      "Stock across all warehouses as of 2026-01-15: 2700 lines, total quantity 12345.678. Source: 1C copy.",
    );
    expect(buildStockSheetCaption(all as never, "ka")).toBe(
      "ნაშთი ყველა საწყობში, 2026-01-15-ის მდგომარეობით: 2700 სტრიქონი, ჯამური რაოდენობა 12345.678. " +
        "წყარო: 1C-ის ასლი.",
    );
    const codeOnly = summary({ warehouse_code: "WH-02" });
    expect(buildStockSheetCaption(codeOnly as never, "en")).toContain("Stock at warehouse WH-02 as of");
    expect(buildStockSheetCaption(codeOnly as never, "ka")).toContain("ნაშთი საწყობში WH-02,");
  });

  it("the caption is built from the server summary only, with brackets escaped", async () => {
    const { run, uploads } = setup({
      exportResponse: () =>
        jsonResponse(exportBody({ warehouse_code: "WH-01", warehouse_name: "[b]Main[/b] [url=https://x.example]y[/url]" })),
    });
    await run({ kind: "stock", warehouse_code: "WH-01" });
    const caption = (uploads[0]?.params.fields as { message: string }).message;
    expect(caption).toContain("&#91;b&#93;Main&#91;/b&#93;");
    expect(caption).not.toMatch(/[[\]]/);
  });
});

describe("log hygiene", () => {
  it("no token, URL, bytes or bot token in any log line or result, across outcomes", async () => {
    const scenarios: SetupOptions[] = [
      {},
      { env: {} },
      { exportResponse: () => jsonResponse({ error: "unauthorized" }, 401) },
      { exportResponse: () => new Response("not json", { status: 200 }) },
      {
        upload: () => {
          throw new Bitrix24Error({ method: "imbot.v2.File.upload", code: "FILE_SEND_FAILED", description: "x" });
        },
      },
      { context: { agentId: "main" } },
    ];
    for (const scenario of scenarios) {
      const { run, log } = setup(scenario);
      const result = await run();
      expectCleanLogs(log, [...consoleLines, JSON.stringify(result)]);
      expect(log.all()).toHaveLength(1);
    }
  });
});

describe("registration", () => {
  it("registers the tool in full mode, optional, under its declared name", async () => {
    const entry = (await import("../src/index.js")).default as unknown as {
      register: (api: unknown) => void;
    };
    const registerTool = vi.fn();
    const registerChannel = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    entry.register({ registrationMode: "full", runtime: {}, logger, registerTool, registerChannel });
    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const [factory, opts] = registerTool.mock.calls[0] as [(ctx: unknown) => { name: string }, unknown];
    expect(opts).toEqual({ name: "bitrix24_send_sheet", optional: true });
    expect(typeof factory).toBe("function");
    // The factory is cheap and never throws, even with an empty context.
    const tool = factory({});
    expect(tool.name).toBe(BITRIX24_SEND_SHEET_TOOL_NAME);
  });

  it("registers the tool in tool-discovery mode without the channel; not in discovery mode", async () => {
    const entry = (await import("../src/index.js")).default as unknown as { register: (api: unknown) => void };
    const toolDiscovery = { registrationMode: "tool-discovery", registerTool: vi.fn(), registerChannel: vi.fn(), logger: {} };
    entry.register(toolDiscovery);
    expect(toolDiscovery.registerTool).toHaveBeenCalledTimes(1);
    expect(toolDiscovery.registerChannel).not.toHaveBeenCalled();
    const discovery = { registrationMode: "discovery", runtime: {}, registerTool: vi.fn(), registerChannel: vi.fn() };
    entry.register(discovery);
    expect(discovery.registerTool).not.toHaveBeenCalled();
    expect(discovery.registerChannel).toHaveBeenCalledTimes(1);
  });

  it("the manifest declares exactly this tool in contracts.tools, optional and side-effecting", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts?: { tools?: string[] };
      toolMetadata?: Record<string, unknown>;
    };
    expect(manifest.contracts?.tools).toEqual([BITRIX24_SEND_SHEET_TOOL_NAME]);
    expect(manifest.toolMetadata).toEqual({
      [BITRIX24_SEND_SHEET_TOOL_NAME]: { optional: true, sideEffecting: true },
    });
  });

  it("a factory-built tool refuses outside a Bitrix turn and uploads nothing", async () => {
    const entry = (await import("../src/index.js")).default as unknown as { register: (api: unknown) => void };
    const registerTool = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    entry.register({ registrationMode: "tool-discovery", registerTool, logger });
    const factory = registerTool.mock.calls[0]?.[0] as (ctx: unknown) => {
      execute: (id: string, params: unknown) => Promise<{ details: SendSheetResult }>;
    };
    const tool = factory({ agentId: AGENT_ID, getRuntimeConfig: () => buildConfig() });
    const result = await tool.execute("call-1", { kind: "stock" });
    expectRefused(result.details, "NOT_A_BITRIX_TURN");
    expect(logger.warn).toHaveBeenCalledWith("[bitrix24] sheet not sent code=NOT_A_BITRIX_TURN");
  });
});

describe("contract bridge: what core derives from an admitted Bitrix turn", () => {
  // Core builds the tool context from the inbound ctx: deliveryContext.to =
  // OriginatingTo ?? To, channel = OriginatingChannel/Provider, requesterSenderId
  // = SenderId (openclaw agent-runner-utils / openclaw-tools.plugin-context).
  async function contextFromTurn(raw: Bitrix24RawEvent): Promise<Partial<OpenClawPluginToolContext>> {
    const cfg = buildConfig();
    const { deps } = buildDeps(cfg);
    const outcome = await handleBitrix24InboundEvent({ deps, raw });
    expect(outcome.status).toBe("dispatched");
    const ctx = harness.turns.at(-1)?.plan.ctxPayload as Record<string, unknown>;
    return {
      agentId: String(ctx.AgentId),
      sessionKey: String(ctx.SessionKey),
      agentAccountId: String(ctx.AccountId),
      deliveryContext: {
        channel: String(ctx.OriginatingChannel),
        to: String(ctx.OriginatingTo ?? ctx.To),
        accountId: String(ctx.AccountId),
      },
      requesterSenderId: String(ctx.SenderId),
    };
  }

  it("a real-shape DM turn yields a context the tool accepts, targeting that DM", async () => {
    const context = await contextFromTurn(realShapeDmEvent({ userId: OWNER, text: "stock sheet please" }));
    expect(context.deliveryContext).toEqual({ channel: "bitrix24", to: DM, accountId: "default" });
    const { run, uploads } = setup({ context });
    expect((await run()).ok).toBe(true);
    expect(uploads[0]?.params.dialogId).toBe(DM);
  });

  it("a real-shape group turn yields a context the tool accepts, targeting that chat", async () => {
    const context = await contextFromTurn(realShapeGroupEvent({ userId: STAFF, dialogId: LISTED_GROUP }));
    expect(context.deliveryContext).toEqual({ channel: "bitrix24", to: LISTED_GROUP, accountId: "default" });
    const { run, uploads } = setup({ context });
    expect((await run()).ok).toBe(true);
    expect(uploads[0]?.params.dialogId).toBe(LISTED_GROUP);
  });
});

describe("loop guard: the bot's own file message (F18)", () => {
  /** A file message posted by the bot itself, as Bitrix would echo it. */
  function botFileEvent(
    base: Bitrix24RawEvent,
    patch: { user?: Record<string, unknown>; authorId?: number | undefined },
  ): Bitrix24RawEvent {
    const data = structuredClone(base.data) as NonNullable<Bitrix24RawEvent["data"]> & {
      message: Record<string, unknown>;
    };
    data.message.text = "Stock across all warehouses as of 2026-01-15: 2700 lines, total quantity 12345.678.";
    data.message.params = { FILE_ID: ["138"] };
    if ("authorId" in patch) {
      if (patch.authorId === undefined) {
        delete data.message.authorId;
        delete data.message.author_id;
      } else {
        data.message.authorId = patch.authorId;
        data.message.author_id = patch.authorId;
      }
    }
    if (patch.user) {
      data.user = patch.user as never;
    }
    return { ...base, data };
  }

  const botUser = { id: Number(BOT_ID), bot: true, externalAuthId: "bot", extranet: false, connector: false };

  it.each([
    ["DM, real shape (authorId, user.id and user.bot all name the bot)", "dm", { user: botUser, authorId: Number(BOT_ID) }],
    ["group, real shape", "group", { user: botUser, authorId: Number(BOT_ID) }],
    ["user.bot true only", "dm", { user: { id: 555, bot: true }, authorId: undefined }],
    ["authorId === botId only", "dm", { user: { id: Number(BOT_ID), bot: false }, authorId: Number(BOT_ID) }],
    ["user.id === botId only", "dm", { user: { id: Number(BOT_ID), bot: false }, authorId: undefined }],
    ["user.id === botId only, in a group", "group", { user: { id: Number(BOT_ID) }, authorId: undefined }],
  ] as const)("%s: dropped, no dispatch, no reply", async (_label, where, patch) => {
    for (const dmPolicy of ["allowlist", "pairing"] as const) {
      harness.turns.length = 0;
      const cfg = buildConfig({ dmPolicy, allowFrom: [String(OWNER), String(STAFF), BOT_ID] });
      const { deps, calls, sent } = buildDeps(cfg);
      const base =
        where === "dm"
          ? realShapeDmEvent({ userId: OWNER })
          : realShapeGroupEvent({ userId: OWNER, text: mention("x") });
      const outcome = await handleBitrix24InboundEvent({ deps, raw: botFileEvent(base, patch) });
      expect(outcome).toEqual({ status: "dropped", reason: "loop_guard" });
      expect(harness.turns).toHaveLength(0);
      expect(calls).toEqual([]);
      expect(sent).toEqual([]);
    }
  });
});
