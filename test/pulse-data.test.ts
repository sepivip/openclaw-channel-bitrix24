// `bitrix24_pulse_data`: a "Customer calls" summary
// from CRM deals only. Arguments, the caller guard, NOT_CONFIGURED, the
// aggregation against a synthetic dataset (two pipelines, stage SEMANTICS
// "process" / null / S / F, the 7-day and 48-hour boundaries), NO_CRM_ACCESS,
// paging and its cap, the throttle, retry and error mapping, personal-data
// minimisation and log hygiene. Offline: Bitrix is the fake CRM portal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resetBitrix24ConfigNotices } from "../src/config-schema.js";
import { BITRIX24_CRM_READ_METHOD_ALLOWLIST } from "../src/crm-client.js";
import {
  BITRIX24_PULSE_DATA_TOOL_NAME,
  bitrix24PulseDataParameters,
  buildPulseWindows,
  createBitrix24PulseDataTool,
  parseBitrixDateTime,
  runBitrix24PulseData,
  stageSemantics,
  validatePulseDataArgs,
  type PulseDataResult,
  type PulseDataSuccess,
} from "../src/pulse-data.js";
import {
  FAKE_CRM_BASE_URL,
  FAKE_CRM_SECRET,
  bitrixError,
  createFakeCrmPortal,
  createScheduledClock,
  type FakeCrmData,
  type FakeDeal,
} from "./fake-bitrix/crm-portal.js";
import { AGENT_ID, buildConfig, captureLog } from "./fixtures.js";

/** Tuesday 2026-09-29, 13:00 in Tbilisi. */
const NOW = Date.parse("2026-09-29T13:00:00+04:00");
const IMBOT_SECRET = "fakefakefake";
const TZ = "+04:00";
const at = (iso: string) => Date.parse(iso);

/** Fields the tool may ever ask for: no title, amount, person or contact. */
const ALLOWED_SELECT = new Set(["id", "categoryId", "stageId", "createdTime", "movedTime"]);

function call(
  id: number,
  stageId: string,
  stageSemanticId: FakeDeal["stageSemanticId"],
  created: string,
  moved: string,
  categoryId = 0,
): FakeDeal {
  return {
    id,
    categoryId,
    stageId,
    stageSemanticId,
    createdTime: `${created}${TZ}`,
    movedTime: `${moved}${TZ}`,
    title: `Call from +995 555 000 ${String(id).padStart(3, "0")}`,
    opportunity: 0,
    assignedById: 11,
    sourceId: "CALL",
    contactId: 9000 + id,
  };
}

function dataset(): FakeCrmData {
  return {
    categories: [
      { id: 5, name: "Wholesale calls", sort: 200, isDefault: "N" },
      { id: 0, name: "ზარები", sort: 100, isDefault: "Y" },
    ],
    stages: [
      { ENTITY_ID: "DEAL_STAGE", STATUS_ID: "NEW", NAME: "ახალი", SORT: "10", SEMANTICS: "process" },
      { ENTITY_ID: "DEAL_STAGE", STATUS_ID: "PREPARATION", NAME: "მუშავდება", SORT: "20", SEMANTICS: null },
      { ENTITY_ID: "DEAL_STAGE", STATUS_ID: "WON", NAME: "წარმატებული", SORT: "30", SEMANTICS: "S" },
      { ENTITY_ID: "DEAL_STAGE", STATUS_ID: "LOSE", NAME: "მიწოდების ვადა", SORT: "40", SEMANTICS: "F" },
      { ENTITY_ID: "DEAL_STAGE", STATUS_ID: "UC_ORDER", NAME: "შეკვეთის სტატუსი", SORT: "50", SEMANTICS: "F" },
      { ENTITY_ID: "DEAL_STAGE", STATUS_ID: "UC_PRODUCT", NAME: "პროდუქტის აღწერა", SORT: "60", SEMANTICS: "F" },
      { ENTITY_ID: "DEAL_STAGE_5", STATUS_ID: "C5:NEW", NAME: "New", SORT: "10", SEMANTICS: "process" },
      { ENTITY_ID: "DEAL_STAGE_5", STATUS_ID: "C5:WON", NAME: "Done", SORT: "20", SEMANTICS: "", EXTRA: { SEMANTICS: "success" } },
      { ENTITY_ID: "DEAL_STAGE_5", STATUS_ID: "C5:LOSE", NAME: "Complaint", SORT: "30", SEMANTICS: "F" },
    ],
    deals: [
      // Closed in the last 7 days (movedTime >= 2026-09-23 00:00).
      call(1, "WON", "S", "2026-09-28T10:00:00", "2026-09-28T12:00:00"), // 2 h
      call(2, "LOSE", "F", "2026-09-27T09:00:00", "2026-09-28T09:00:00"), // 24 h
      call(3, "LOSE", "F", "2026-09-22T20:00:00", "2026-09-23T00:00:00"), // moved exactly at the window start; 4 h
      call(4, "UC_ORDER", "F", "2026-09-25T10:00:00", "2026-09-25T10:30:00"), // 0.5 h
      call(5, "UC_ORDER", "F", "2026-09-20T10:00:00", "2026-09-26T10:00:00"), // 144 h
      call(6, "UC_PRODUCT", "F", "2026-09-29T08:00:00", "2026-09-29T11:00:00"), // 3 h
      call(7, "C5:LOSE", "F", "2026-09-24T09:00:00", "2026-09-24T15:30:00", 5), // 6.5 h
      call(8, "WON", "S", "2026-09-26T09:00:00", "2026-09-26T16:45:00"), // 7.75 h
      call(9, "LOSE", "F", "2026-09-23T00:00:00", "2026-09-23T00:30:00"), // created exactly at the window start; 0.5 h
      // Closed in the 7 days before (2026-09-16 00:00 <= movedTime < 2026-09-23 00:00).
      call(10, "WON", "S", "2026-09-20T10:00:00", "2026-09-22T23:59:59"),
      call(11, "LOSE", "F", "2026-09-16T00:00:00", "2026-09-16T00:00:00"),
      call(12, "UC_ORDER", "F", "2026-09-15T23:59:59", "2026-09-18T10:00:00"),
      // Closed before both windows.
      call(13, "LOSE", "F", "2026-09-10T10:00:00", "2026-09-15T23:59:59"),
      call(30, "WON", "S", "2026-01-05T10:00:00", "2026-01-06T10:00:00"),
      // Waiting now (in progress; stage SEMANTICS "process" or null).
      call(20, "NEW", "P", "2026-09-26T09:00:00", "2026-09-26T09:00:00"), // 3 days 4 h: over 2 days
      call(21, "PREPARATION", "P", "2026-09-28T12:00:00", "2026-09-28T12:00:00"), // 25 h
      call(22, "C5:NEW", "P", "2026-09-27T13:00:00", "2026-09-27T13:00:00", 5), // exactly 48 h: not over
    ],
  };
}

type SetupOptions = {
  section?: Record<string, unknown>;
  cfg?: never;
  data?: FakeCrmData;
  env?: NodeJS.ProcessEnv;
  maxPages?: number;
  context?: Record<string, unknown>;
};

function setup(opts: SetupOptions = {}) {
  const clock = createScheduledClock(NOW);
  const portal = createFakeCrmPortal(opts.data ?? dataset(), { now: clock.now });
  const log = captureLog();
  const cfg = opts.cfg ?? buildConfig({ crmWebhookUrl: FAKE_CRM_BASE_URL, ...opts.section });
  const context = (opts.context ?? { agentId: AGENT_ID, getRuntimeConfig: () => cfg }) as OpenClawPluginToolContext;
  const deps = {
    context,
    log,
    env: opts.env ?? {},
    fetchImpl: portal.fetch,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    ...(opts.maxPages === undefined ? {} : { maxPages: opts.maxPages }),
  };
  return {
    clock,
    portal,
    log,
    deps,
    cfg,
    run: (args: unknown = {}, signal?: AbortSignal) => clock.run(runBitrix24PulseData(deps, args, signal)),
  };
}

function expectOk(result: PulseDataResult): PulseDataSuccess {
  expect(result).toMatchObject({ ok: true });
  return result as PulseDataSuccess;
}

async function calls(opts: SetupOptions = {}) {
  const s = setup(opts);
  const result = expectOk(await s.run());
  return { ...s, result, c: result.sections.calls! };
}

function itemFilters(portal: ReturnType<typeof setup>["portal"]) {
  return portal.calls.filter((c) => c.method === "crm.item.list").map((c) => c.params.filter as Record<string, unknown>);
}

let consoleLines: string[] = [];
beforeEach(() => {
  resetBitrix24ConfigNotices();
  consoleLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

describe("tool surface", () => {
  it("takes only an optional sections list whose one value is calls", () => {
    expect(bitrix24PulseDataParameters).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(bitrix24PulseDataParameters.properties)).toEqual(["sections"]);
    expect(bitrix24PulseDataParameters.properties.sections.items.enum).toEqual(["calls"]);
    expect("required" in bitrix24PulseDataParameters).toBe(false);
  });

  it("the concrete tool is read-only, parallel-safe and returns text + details", async () => {
    const { deps, clock } = setup();
    const tool = createBitrix24PulseDataTool(deps);
    expect(tool.name).toBe(BITRIX24_PULSE_DATA_TOOL_NAME);
    expect(tool.executionMode).toBe("parallel");
    expect(tool.description).toContain("customer calls");
    expect(tool.description).toContain("NO_CRM_ACCESS");
    expect(tool.description).toContain("cannot change anything");
    expect(tool.description).not.toMatch(/[–—]/);
    const result = await clock.run(tool.execute("call-1", {}));
    expect(result.details).toMatchObject({ ok: true });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
  });
});

describe("arguments", () => {
  it.each([
    ["a dropped section (pipeline)", { sections: ["pipeline"] }],
    ["a dropped section (tasks)", { sections: ["calls", "tasks"] }],
    ["a dropped section (calendar)", { sections: ["calendar"] }],
    ["an empty list", { sections: [] }],
    ["a string instead of a list", { sections: "calls" }],
    ["a non-string entry", { sections: [1] }],
    ["a method argument", { method: "crm.item.add" }],
    ["an extra filter argument", { sections: ["calls"], filter: { ID: 1 } }],
    ["a string", "calls"],
    ["an array", ["calls"]],
  ])("refuses %s with INVALID_ARGUMENTS and makes no call", async (_label, args) => {
    const { run, portal } = setup();
    const result = await run(args);
    expect(result).toMatchObject({ ok: false, error_code: "INVALID_ARGUMENTS" });
    expect(portal.calls).toHaveLength(0);
  });

  it("defaults to calls for {}, undefined and null, and dedupes", () => {
    for (const raw of [{}, undefined, null, { sections: undefined }, { sections: ["calls", "calls"] }]) {
      expect(validatePulseDataArgs(raw)).toEqual({ sections: ["calls"] });
    }
  });
});

describe("caller: only the agent bound to the bitrix24 channel", () => {
  function withContext(context: Record<string, unknown>, cfg?: never) {
    const effective = cfg ?? buildConfig({ crmWebhookUrl: FAKE_CRM_BASE_URL });
    return setup({ cfg: effective as never, context: { getRuntimeConfig: () => effective, ...context } });
  }

  it("allows the bound agent on a direct turn with no Bitrix deliveryContext or sender", async () => {
    const { run, portal } = withContext({ agentId: AGENT_ID, sessionKey: `agent:${AGENT_ID}:main` });
    expectOk(await run());
    expect(portal.calls.length).toBeGreaterThan(0);
  });

  it("allows the bound agent on a Bitrix turn too, and normalises case and spaces like send_sheet", async () => {
    const { run } = withContext({
      agentId: ` ${AGENT_ID.toUpperCase()} `,
      deliveryContext: { channel: "bitrix24", to: "4101", accountId: "default" },
      requesterSenderId: "4101",
    });
    expectOk(await run());
  });

  it.each([
    ["main", { agentId: "main" }],
    ["another agent on a Bitrix route", { agentId: "helper", deliveryContext: { channel: "bitrix24", to: "4101" } }],
    ["no agent id (operator /tools/invoke)", {}],
    ["an empty agent id", { agentId: "  " }],
  ])("refuses %s with NOT_BITRIX_AGENT and zero CRM requests", async (_label, context) => {
    const { run, portal, log } = withContext(context);
    const result = await run();
    expect(result).toMatchObject({ ok: false, error_code: "NOT_BITRIX_AGENT" });
    expect(portal.calls).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith("[bitrix24] pulse data failed code=NOT_BITRIX_AGENT");
  });

  it.each([
    ["no bindings", { bindings: [] }],
    ["a binding for another channel only", { bindings: [{ type: "route", agentId: AGENT_ID, match: { channel: "telegram" } }] }],
    [
      "bindings naming two agents",
      {
        bindings: [
          { type: "route", agentId: AGENT_ID, match: { channel: "bitrix24", accountId: "*" } },
          { type: "route", agentId: "main", match: { channel: "bitrix24", accountId: "default" } },
        ],
      },
    ],
  ])("refuses the would-be agent when the config has %s", async (_label, extra) => {
    const cfg = buildConfig({ crmWebhookUrl: FAKE_CRM_BASE_URL }, extra);
    const { run, portal } = withContext({ agentId: AGENT_ID }, cfg);
    const result = await run();
    expect(result).toMatchObject({ ok: false, error_code: "NOT_BITRIX_AGENT" });
    expect(portal.calls).toHaveLength(0);
  });

  it("accepts a binding without accountId (the default account)", async () => {
    const cfg = buildConfig(
      { crmWebhookUrl: FAKE_CRM_BASE_URL },
      { bindings: [{ agentId: AGENT_ID, match: { channel: "bitrix24" } }] },
    );
    const { run } = withContext({ agentId: AGENT_ID }, cfg);
    expectOk(await run());
  });

  it("the registered factory refuses main and a context without an agent id", async () => {
    const entry = (await import("../src/index.js")).default as unknown as { register: (api: unknown) => void };
    const registerTool = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    entry.register({ registrationMode: "tool-discovery", registerTool, logger });
    const factory = registerTool.mock.calls.find((c) => (c[1] as { name: string }).name === BITRIX24_PULSE_DATA_TOOL_NAME)?.[0] as (
      ctx: unknown,
    ) => { execute: (id: string, params: unknown) => Promise<{ details: PulseDataResult }> };
    const cfg = buildConfig({ crmWebhookUrl: FAKE_CRM_BASE_URL });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network call attempted");
    });
    try {
      for (const ctx of [{ agentId: "main", getRuntimeConfig: () => cfg }, { getRuntimeConfig: () => cfg }]) {
        const result = await factory(ctx).execute("call-1", {});
        expect(result.details).toMatchObject({ ok: false, error_code: "NOT_BITRIX_AGENT" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("NOT_CONFIGURED", () => {
  it.each([
    ["no crmWebhookUrl", { crmWebhookUrl: undefined }],
    ["an empty crmWebhookUrl", { crmWebhookUrl: "" }],
    ["an unset env SecretRef", { crmWebhookUrl: { source: "env", provider: "default", id: "BITRIX24_CRM_WEBHOOK_URL" } }],
    ["an unset ${VAR}", { crmWebhookUrl: "${BITRIX24_CRM_WEBHOOK_URL}" }],
    ["a disabled channel", { enabled: false }],
    ["an http URL", { crmWebhookUrl: "http://synthetic.bitrix24.test/rest/77/crmReadS3cretT0ken/" }],
    ["a host outside portalDomain", { crmWebhookUrl: "https://evil.example.com/rest/77/crmReadS3cretT0ken/" }],
    ["a malformed URL", { crmWebhookUrl: "crmReadS3cretT0ken" }],
    ["no portalDomain", { portalDomain: undefined }],
    ["a broken channel (no botToken)", { botToken: undefined }],
  ])("%s: NOT_CONFIGURED, no call, no URL in the message or log", async (_label, section) => {
    const { run, portal, log } = setup({ section });
    const result = await run();
    expect(result).toMatchObject({ ok: false, error_code: "NOT_CONFIGURED" });
    expect(portal.calls).toHaveLength(0);
    const text = [JSON.stringify(result), ...log.all(), ...consoleLines].join("\n");
    expect(text).not.toContain(FAKE_CRM_SECRET);
    expect(text).not.toContain("evil.example.com");
    expect(log.warn).toHaveBeenCalledWith("[bitrix24] pulse data failed code=NOT_CONFIGURED");
  });

  it("no runtime config at all is NOT_CONFIGURED", async () => {
    const { deps, clock, portal } = setup();
    const result = await clock.run(runBitrix24PulseData({ ...deps, context: {} as OpenClawPluginToolContext }, {}));
    expect(result).toMatchObject({ ok: false, error_code: "NOT_CONFIGURED", message: "no runtime config is available" });
    expect(portal.calls).toHaveLength(0);
  });

  it("resolves ${BITRIX24_CRM_WEBHOOK_URL} and an env SecretRef from the environment", async () => {
    const env = { BITRIX24_CRM_WEBHOOK_URL: FAKE_CRM_BASE_URL };
    for (const crmWebhookUrl of [
      "${BITRIX24_CRM_WEBHOOK_URL}",
      { source: "env", provider: "default", id: "BITRIX24_CRM_WEBHOOK_URL" },
    ]) {
      const { run } = setup({ section: { crmWebhookUrl }, env });
      expectOk(await run());
    }
  });

  it("uses only the CRM webhook and only allowlisted methods", async () => {
    const { run, portal } = setup();
    expectOk(await run());
    expect(portal.calls.length).toBeGreaterThan(0);
    // The fake portal throws on any other base URL.
    for (const c of portal.calls) {
      expect(BITRIX24_CRM_READ_METHOD_ALLOWLIST as readonly string[]).toContain(c.method);
    }
  });
});

describe("windows and parsing", () => {
  it("rolls whole Tbilisi days: last 7 = today-6..today, prior 7 = today-13..today-7", () => {
    const w = buildPulseWindows(NOW);
    expect(w).toMatchObject({ today: "2026-09-29", windowFrom: "2026-09-23", priorFrom: "2026-09-16", priorTo: "2026-09-22" });
    expect(w.windowStartMs).toBe(at("2026-09-23T00:00:00+04:00"));
    expect(w.priorStartMs).toBe(at("2026-09-16T00:00:00+04:00"));
  });

  it("uses the Tbilisi date, not the UTC date, around midnight", () => {
    expect(buildPulseWindows(at("2026-09-28T21:30:00Z")).today).toBe("2026-09-29");
    expect(buildPulseWindows(at("2026-09-28T19:59:59Z")).today).toBe("2026-09-28");
  });

  it("parses Bitrix datetimes with any offset", () => {
    expect(parseBitrixDateTime("2026-09-22T21:30:00+01:00")).toBe(at("2026-09-23T00:30:00+04:00"));
    expect(parseBitrixDateTime("2026-09-22T21:30:00+0100")).toBe(at("2026-09-23T00:30:00+04:00"));
    expect(parseBitrixDateTime("2026-09-22T17:30:00Z")).toBe(at("2026-09-22T21:30:00+04:00"));
    expect(parseBitrixDateTime("2026-09-22T21:30:00")).toBe(at("2026-09-22T21:30:00+04:00"));
    for (const bad of ["", "22.09.2026", "2026-02-30T10:00:00+04:00", "2026-09-22T25:00:00Z", null, 5]) {
      expect(parseBitrixDateTime(bad)).toBeUndefined();
    }
  });

  it.each([
    [{ SEMANTICS: "process" }, "P"],
    [{ SEMANTICS: null }, "P"],
    [{ SEMANTICS: "" }, "P"],
    [{}, "P"],
    [{ SEMANTICS: "P" }, "P"],
    [{ SEMANTICS: "S" }, "S"],
    [{ SEMANTICS: "F" }, "F"],
    [{ SEMANTICS: "success" }, "S"],
    [{ SEMANTICS: "failure" }, "F"],
    [{ SEMANTICS: "", EXTRA: { SEMANTICS: "success" } }, "S"],
    [{ SEMANTICS: null, EXTRA: { SEMANTICS: "failure" } }, "F"],
    [{ SEMANTICS: "process", EXTRA: { SEMANTICS: "failure" } }, "P"],
  ])("stage semantics %j is %s (process and null/empty are in progress)", (row, expected) => {
    expect(stageSemantics(row as Record<string, unknown>)).toBe(expected);
  });
});

describe("calls section", () => {
  it("created: last 7 days vs the 7 before, from the list total, boundaries inclusive at each start", async () => {
    const { c, portal } = await calls();
    // 9 is created exactly at the window start; 11 exactly at the prior start; 12 one second before it.
    expect(c.created).toEqual({ last_7_days: 10, prior_7_days: 4 });
    const created = portal.calls.filter((x) => {
      const f = x.params.filter as Record<string, unknown> | undefined;
      return x.method === "crm.item.list" && f && ">=createdTime" in f;
    });
    expect(created.map((x) => [x.params.select, x.params.filter, x.params.start])).toEqual([
      [["id"], { ">=createdTime": "2026-09-23T00:00:00+04:00" }, 0],
      [["id"], { ">=createdTime": "2026-09-16T00:00:00+04:00", "<createdTime": "2026-09-23T00:00:00+04:00" }, 0],
    ]);
  });

  it("closed: won (S) plus topic (F) stages moved in each window", async () => {
    const { c, portal } = await calls();
    // 3 moved exactly at the window start; 10 one second before it; 11 exactly at the prior start; 13 one second before.
    expect(c.closed).toEqual({ last_7_days: 9, prior_7_days: 3 });
    const filters = itemFilters(portal).filter((f) => f.stageSemanticId === "S" || f.stageSemanticId === "F");
    expect(filters).toEqual(
      expect.arrayContaining([
        { stageSemanticId: "S", ">=movedTime": "2026-09-23T00:00:00+04:00" },
        { stageSemanticId: "F", ">=movedTime": "2026-09-23T00:00:00+04:00" },
        { stageSemanticId: "S", ">=movedTime": "2026-09-16T00:00:00+04:00", "<movedTime": "2026-09-23T00:00:00+04:00" },
        { stageSemanticId: "F", ">=movedTime": "2026-09-16T00:00:00+04:00", "<movedTime": "2026-09-23T00:00:00+04:00" },
      ]),
    );
    expect(filters).toHaveLength(4);
  });

  it("waiting now: in-progress count, oldest in whole days, and over 2 days strictly (48 h exactly is not)", async () => {
    const { c, portal } = await calls();
    expect(c.waiting_now).toBe(3);
    // Deal 20 (stage SEMANTICS "process") is the oldest: 3 days 4 hours.
    expect(c.oldest_waiting_days).toBe(3);
    expect(c.waiting_over_2_days).toBe(1);
    const waiting = portal.calls.filter(
      (x) => x.method === "crm.item.list" && (x.params.filter as Record<string, unknown>).stageSemanticId === "P",
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.params).toMatchObject({ order: { createdTime: "ASC" }, start: 0 });
  });

  it("median hours to close over the last 7 days, one decimal", async () => {
    const { c } = await calls();
    // 0.5, 0.5, 2, 3, 4, 6.5, 7.75, 24, 144 -> 4
    expect(c.median_hours_to_close_last_7_days).toBe(4);
  });

  it("median of an even count is the mean of the middle two, rounded to one decimal", async () => {
    const data = dataset();
    data.deals = [
      call(1, "WON", "S", "2026-09-28T10:00:00", "2026-09-28T11:00:00"), // 1 h
      call(2, "LOSE", "F", "2026-09-28T10:00:00", "2026-09-28T12:30:00"), // 2.5 h
    ];
    const { c } = await calls({ data });
    expect(c.median_hours_to_close_last_7_days).toBe(1.8);
  });

  it("topics: closed stages of the last 7 days by count, ties in pipeline and stage order", async () => {
    const { c } = await calls();
    expect(c.topics_last_7_days).toEqual([
      { stage: "მიწოდების ვადა", semantics: "F", count: 3 },
      { stage: "წარმატებული", semantics: "S", count: 2 },
      { stage: "შეკვეთის სტატუსი", semantics: "F", count: 2 },
      { stage: "პროდუქტის აღწერა", semantics: "F", count: 1 },
      { stage: "Complaint", semantics: "F", count: 1 },
    ]);
  });

  it("pipelines: every deal pipeline in sort order with its closed count", async () => {
    const { c, portal } = await calls();
    expect(c.pipelines).toEqual([
      { id: 0, name: "ზარები", closed_last_7_days: 8 },
      { id: 5, name: "Wholesale calls", closed_last_7_days: 1 },
    ]);
    expect(
      portal.calls.filter((x) => x.method === "crm.status.list").map((x) => (x.params.filter as { ENTITY_ID: string }).ENTITY_ID),
    ).toEqual(["DEAL_STAGE", "DEAL_STAGE_5"]);
  });

  it("windows are part of the section", async () => {
    const { c } = await calls();
    expect(c.window).toEqual({ from: "2026-09-23", to: "2026-09-29" });
    expect(c.prior_window).toEqual({ from: "2026-09-16", to: "2026-09-22" });
  });

  it("nothing waiting and nothing closed: zeros and nulls, not errors", async () => {
    const data = dataset();
    data.deals = [call(30, "WON", "S", "2026-01-05T10:00:00", "2026-01-06T10:00:00")];
    const { c } = await calls({ data });
    expect(c).toMatchObject({
      created: { last_7_days: 0, prior_7_days: 0 },
      closed: { last_7_days: 0, prior_7_days: 0 },
      waiting_now: 0,
      oldest_waiting_days: null,
      waiting_over_2_days: 0,
      median_hours_to_close_last_7_days: null,
      topics_last_7_days: [],
    });
    expect(c.pipelines.map((p) => p.closed_last_7_days)).toEqual([0, 0]);
  });

  it("a stage missing from crm.status.list is named by its id", async () => {
    const data = dataset();
    data.deals = [call(1, "UC_NEWTOPIC", "F", "2026-09-28T10:00:00", "2026-09-28T11:00:00")];
    const { c } = await calls({ data });
    expect(c.topics_last_7_days).toEqual([{ stage: "UC_NEWTOPIC", semantics: "F", count: 1 }]);
  });

  it("a row whose known stage contradicts the query's semantics is not counted", async () => {
    const data = dataset();
    // Bitrix says F, but WON is a success stage: inconsistent, so it is left out.
    data.deals = [call(1, "WON", "F", "2026-09-28T10:00:00", "2026-09-28T11:00:00")];
    const { c } = await calls({ data });
    expect(c.closed.last_7_days).toBe(0);
  });
});

describe("NO_CRM_ACCESS", () => {
  it("zero pipelines means no read access: the section is unavailable, not zero calls", async () => {
    const data = dataset();
    data.categories = [];
    const { run, portal, log } = setup({ data });
    const result = await run();
    expect(result).toEqual({
      ok: false,
      error_code: "ALL_SECTIONS_UNAVAILABLE",
      message: "no Bitrix24 section could be read",
      unavailable: [
        {
          section: "calls",
          code: "NO_CRM_ACCESS",
          message: "the service user cannot read any deal pipeline (no CRM read access)",
        },
      ],
    });
    // Only the pipeline list was asked; no deal was read.
    expect(portal.methods()).toEqual(["crm.category.list"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("unavailable=calls:NO_CRM_ACCESS"));
  });
});

describe("personal data stays out", () => {
  it("never selects a title, amount, person or contact, and returns none", async () => {
    const { result, portal } = await calls();
    for (const c of portal.calls.filter((x) => x.method === "crm.item.list")) {
      const select = c.params.select as string[];
      expect(Array.isArray(select)).toBe(true);
      for (const field of select) {
        expect(ALLOWED_SELECT.has(field)).toBe(true);
      }
    }
    const text = JSON.stringify(result);
    for (const forbidden of ["Call from", "+995", "assignee", "amount", "opportunity", "contact", "title", "CALL"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("paging and truncation", () => {
  function manyClosed(n: number): FakeCrmData {
    const data = dataset();
    data.deals = Array.from({ length: n }, (_, i) =>
      call(1000 + i, i % 2 === 0 ? "LOSE" : "UC_ORDER", "F", "2026-09-27T09:00:00", "2026-09-27T10:00:00"),
    );
    return data;
  }

  it("pages through 120 closed calls (start 0, 50, 100) and counts every one", async () => {
    const { c, result, portal } = await calls({ data: manyClosed(120) });
    expect(c.closed.last_7_days).toBe(120);
    expect(c.topics_last_7_days).toEqual([
      { stage: "მიწოდების ვადა", semantics: "F", count: 60 },
      { stage: "შეკვეთის სტატუსი", semantics: "F", count: 60 },
    ]);
    expect(result.meta.truncated).toEqual({ calls: false });
    const starts = portal.calls
      .filter((x) => {
        const f = x.params.filter as Record<string, unknown>;
        return x.method === "crm.item.list" && f.stageSemanticId === "F" && !("<movedTime" in f);
      })
      .map((x) => x.params.start);
    expect(starts).toEqual([0, 50, 100]);
  });

  it("reports truncated when the page cap is hit, never silently", async () => {
    const { c, result } = await calls({ data: manyClosed(260), maxPages: 2 });
    expect(result.meta.truncated).toEqual({ calls: true });
    expect(result.meta.page_cap).toBe(2);
    expect(c.closed.last_7_days).toBe(100);
  });

  it("more waiting calls than one page: count from the total, over-2-days from its own count query", async () => {
    const data = dataset();
    data.deals = Array.from({ length: 60 }, (_, i) =>
      // 20 created 5 days ago, 40 created 1 hour ago.
      i < 20
        ? call(2000 + i, "NEW", "P", "2026-09-24T12:00:00", "2026-09-24T12:00:00")
        : call(2000 + i, "NEW", "P", "2026-09-29T12:00:00", "2026-09-29T12:00:00"),
    );
    const { c, portal, result } = await calls({ data });
    expect(c.waiting_now).toBe(60);
    expect(c.oldest_waiting_days).toBe(5);
    expect(c.waiting_over_2_days).toBe(20);
    expect(itemFilters(portal)).toContainEqual({ stageSemanticId: "P", "<createdTime": "2026-09-27T13:00:00+04:00" });
    expect(result.meta.truncated).toEqual({ calls: false });
  });

  it("uses a page cap of 40 and a page size of 50 by default", async () => {
    const { result } = await calls();
    expect(result.meta).toMatchObject({ page_cap: 40, page_size: 50 });
  });
});

describe("throttle and request budget", () => {
  it("a full run never starts more than 2 requests in any second", async () => {
    const { result, portal } = await calls();
    const starts = portal.calls.map((x) => x.at);
    expect(starts.length).toBe(result.meta.requests.total);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(500);
    }
    for (const t of starts) {
      expect(starts.filter((s) => s >= t && s < t + 1000).length).toBeLessThanOrEqual(2);
    }
    expect(result.meta.elapsed_ms.total).toBeGreaterThanOrEqual((starts.length - 1) * 500);
  });

  it("reports requests and elapsed time", async () => {
    const { result } = await calls();
    // category 1 + stages 2 + created 2 + closed S/F 2 + prior S/F 2 + waiting 1
    expect(result.meta.requests).toEqual({ total: 10, calls: 10 });
    expect(Object.keys(result.meta.elapsed_ms).sort()).toEqual(["calls", "total"]);
  });
});

describe("retry and error mapping", () => {
  it("retries a 503 QUERY_LIMIT_EXCEEDED once and keeps the section", async () => {
    const { run, portal } = setup();
    portal.respond("crm.category.list", (_p, index) => (index === 0 ? bitrixError("QUERY_LIMIT_EXCEEDED", 503) : undefined));
    const result = expectOk(await run());
    expect(result.sections.calls!.closed.last_7_days).toBe(9);
    expect(portal.count("crm.category.list")).toBe(2);
    expect(result.meta.requests.calls).toBe(11);
  });

  it("gives up after one retry on 429 OPERATION_TIME_LIMIT and names that code", async () => {
    const { run, portal } = setup();
    portal.respond("crm.item.list", () => bitrixError("OPERATION_TIME_LIMIT", 429));
    const result = await run();
    expect(result).toMatchObject({
      ok: false,
      error_code: "ALL_SECTIONS_UNAVAILABLE",
      unavailable: [
        { section: "calls", code: "OPERATION_TIME_LIMIT", message: "Bitrix24 time limit for this method; try again in a minute" },
      ],
    });
  });

  it.each([
    ["ACCESS_DENIED", 403],
    ["insufficient_scope", 401],
  ])("maps %s (HTTP %i) to ACCESS_DENIED", async (code, status) => {
    const { run, portal } = setup();
    portal.respond("crm.item.list", () => bitrixError(code, status, "Access denied for Secret Project"));
    const result = await run();
    expect(result).toMatchObject({ ok: false, unavailable: [{ section: "calls", code: "ACCESS_DENIED" }] });
    expect(JSON.stringify(result)).not.toContain("Secret Project");
  });

  it("a malformed answer is INVALID_RESPONSE", async () => {
    const { run, portal } = setup();
    portal.respond("crm.status.list", () => new Response(JSON.stringify({ result: { not: "a list" } })));
    const result = await run();
    expect(result).toMatchObject({ ok: false, unavailable: [{ section: "calls", code: "INVALID_RESPONSE" }] });
  });

  it("an already-aborted call makes no request", async () => {
    const { run, portal } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await run({}, controller.signal);
    expect(result).toMatchObject({ ok: false, error_code: "ABORTED" });
    expect(portal.calls).toHaveLength(0);
  });
});

describe("result shape", () => {
  it("has as_of, generated_at, timezone, sections.calls, unavailable and meta", async () => {
    const { result } = await calls();
    expect(Object.keys(result).sort()).toEqual(
      ["as_of", "generated_at", "meta", "ok", "sections", "timezone", "unavailable"].sort(),
    );
    expect(result.as_of).toBe("2026-09-29");
    expect(result.generated_at).toBe("2026-09-29T13:00:00+04:00");
    expect(result.timezone).toBe("Asia/Tbilisi");
    expect(Object.keys(result.sections)).toEqual(["calls"]);
    expect(Object.keys(result.sections.calls!).sort()).toEqual(
      [
        "closed",
        "created",
        "median_hours_to_close_last_7_days",
        "oldest_waiting_days",
        "pipelines",
        "prior_window",
        "topics_last_7_days",
        "waiting_now",
        "waiting_over_2_days",
        "window",
      ].sort(),
    );
    expect(result.unavailable).toEqual([]);
    expect(result.meta).toMatchObject({
      sections_requested: ["calls"],
      truncated: { calls: false },
      page_size: 50,
      page_cap: 40,
    });
  });
});

describe("log hygiene", () => {
  it("no webhook URL, token, host or Bitrix text in any log line, console line or result", async () => {
    const scenarios: Array<(portal: ReturnType<typeof setup>["portal"]) => void> = [
      () => {},
      (portal) => portal.respond("crm.item.list", () => bitrixError("ACCESS_DENIED", 403, "denied for Secret Project")),
      (portal) => portal.respond("crm.status.list", () => bitrixError("QUERY_LIMIT_EXCEEDED", 503, "Secret Project")),
      (portal) =>
        portal.respond("crm.category.list", () => {
          throw new TypeError(`fetch failed: ${FAKE_CRM_BASE_URL}crm.category.list`);
        }),
    ];
    for (const arrange of scenarios) {
      consoleLines = [];
      const { run, portal, log } = setup();
      arrange(portal);
      const result = await run();
      const text = [...log.all(), ...consoleLines, JSON.stringify(result)].join("\n");
      for (const forbidden of [FAKE_CRM_SECRET, IMBOT_SECRET, "synthetic.bitrix24.test", "rest/77", "Secret Project"]) {
        expect(text).not.toContain(forbidden);
      }
      const summaries = [...log.info.mock.calls, ...log.warn.mock.calls].filter((c) =>
        String(c[0]).startsWith("[bitrix24] pulse data"),
      );
      expect(summaries).toHaveLength(1);
      expect(log.debug.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it("the summary line carries sections, counts, timing and the webhook fingerprint only", async () => {
    const { log } = await calls();
    const line = String(log.info.mock.calls[0]![0]);
    expect(line).toMatch(
      /^\[bitrix24\] pulse data ok sections=calls unavailable=none truncated=none requests=10 elapsedMs=\d+ crmWebhookFp=[0-9a-f]{16}$/,
    );
  });
});
