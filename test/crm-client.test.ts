// The read-only CRM client: T-7b
// (exact read allowlist, synchronous refusal before any I/O), paging and its
// cap, the 2 req/s throttle, one retry on a rate limit, error mapping and log
// hygiene. Offline: every Bitrix answer comes from an injected fetch stub.

import { describe, expect, it, vi } from "vitest";
import { BITRIX24_METHOD_ALLOWLIST, assertAllowedBitrix24Method } from "../src/client.js";
import {
  BITRIX24_CRM_MAX_PAGES,
  BITRIX24_CRM_READ_METHOD_ALLOWLIST,
  assertAllowedBitrix24CrmReadMethod,
  createBitrix24CrmClient,
  type Bitrix24CrmClientOptions,
} from "../src/crm-client.js";
import { Bitrix24ConfigError, Bitrix24Error } from "../src/secrets.js";
import { createScheduledClock } from "./fake-bitrix/crm-portal.js";
import { captureLog } from "./fixtures.js";

const PORTAL_DOMAINS = ["bitrix24.test"];
const CRM_URL = "https://synthetic.bitrix24.test/rest/77/crmReadS3cretT0ken/";
const SECRET = "crmReadS3cretT0ken";

const WRITE_METHODS = [
  "crm.item.add",
  "crm.item.update",
  "crm.item.delete",
  "crm.deal.add",
  "crm.deal.update",
  "crm.deal.delete",
  "crm.deal.list",
  "crm.status.add",
  "crm.category.update",
  "tasks.task.add",
  "tasks.task.update",
  "tasks.task.delete",
  "tasks.task.complete",
  "calendar.event.add",
  "calendar.event.update",
  "calendar.event.delete",
  "calendar.section.add",
  "user.add",
  "user.update",
  // Reads that Gate 2 dropped (customer calls only): refused like any write.
  "tasks.task.list",
  "calendar.event.get",
  "calendar.section.get",
  "user.get",
  "user.current",
  "crm.deal.get",
  "crm.contact.list",
  "batch",
  "imbot.v2.Chat.Message.send",
  "imbot.v2.File.upload",
  "disk.folder.uploadfile",
  "im.message.add",
  "profile",
  "crm.item.list ",
  "CRM.ITEM.LIST",
  "crm.item.list/../crm.item.add",
  "",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function forbiddenFetch() {
  return vi.fn(() => {
    throw new Error("network call attempted");
  });
}

/** A fake clock whose sleep advances time instantly. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get t() {
      return t;
    },
  };
}

function client(overrides: Partial<Bitrix24CrmClientOptions> & { fetchImpl: unknown }) {
  const clock = fakeClock();
  const { fetchImpl, ...rest } = overrides;
  return createBitrix24CrmClient({
    baseUrl: CRM_URL,
    portalDomains: PORTAL_DOMAINS,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    ...rest,
    fetchImpl: fetchImpl as typeof fetch,
  });
}

function syncThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("T-7b: read-only CRM method allowlist", () => {
  it("is exactly the three CRM list methods, in order", () => {
    expect([...BITRIX24_CRM_READ_METHOD_ALLOWLIST]).toEqual([
      "crm.item.list",
      "crm.category.list",
      "crm.status.list",
    ]);
    expect(BITRIX24_CRM_READ_METHOD_ALLOWLIST).toHaveLength(3);
    expect(Object.isFrozen(BITRIX24_CRM_READ_METHOD_ALLOWLIST)).toBe(true);
    for (const method of BITRIX24_CRM_READ_METHOD_ALLOWLIST) {
      expect(() => assertAllowedBitrix24CrmReadMethod(method)).not.toThrow();
      expect(method).toMatch(/^crm\.[a-z]+\.list$/);
    }
  });

  it("holds no write verb and no batch", () => {
    for (const method of BITRIX24_CRM_READ_METHOD_ALLOWLIST) {
      expect(method).not.toMatch(/add|update|delete|set|send|upload|complete|batch|import|export/i);
    }
  });

  it.each(WRITE_METHODS)("call(%j) throws METHOD_NOT_ALLOWED synchronously with zero fetch calls", (method) => {
    const fetchImpl = forbiddenFetch();
    const crm = client({ fetchImpl });
    // Not `rejects`: `call` must throw, not return a rejected promise.
    const thrown = syncThrow(() => crm.call(method, { entityTypeId: 2 }));
    expect(thrown).toBeInstanceOf(Bitrix24Error);
    expect((thrown as Bitrix24Error).code).toBe("METHOD_NOT_ALLOWED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(WRITE_METHODS)("list(%j) throws METHOD_NOT_ALLOWED synchronously with zero fetch calls", (method) => {
    const fetchImpl = forbiddenFetch();
    const crm = client({ fetchImpl });
    const thrown = syncThrow(() => crm.list(method, {}, () => []));
    expect(thrown).toBeInstanceOf(Bitrix24Error);
    expect((thrown as Bitrix24Error).code).toBe("METHOD_NOT_ALLOWED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("T-7 is unchanged: the imbot allowlist is still exactly six imbot.v2 methods, none of them a CRM read", () => {
    expect([...BITRIX24_METHOD_ALLOWLIST]).toEqual([
      "imbot.v2.Bot.register",
      "imbot.v2.Bot.update",
      "imbot.v2.Event.get",
      "imbot.v2.Chat.Message.send",
      "imbot.v2.Chat.InputAction.notify",
      "imbot.v2.File.upload",
    ]);
    for (const method of BITRIX24_CRM_READ_METHOD_ALLOWLIST) {
      expect(() => assertAllowedBitrix24Method(method)).toThrow(Bitrix24Error);
    }
    for (const method of BITRIX24_METHOD_ALLOWLIST) {
      expect(() => assertAllowedBitrix24CrmReadMethod(method)).toThrow(Bitrix24Error);
    }
  });

  it("the refusal never carries the webhook token", () => {
    const error = syncThrow(() => client({ fetchImpl: forbiddenFetch() }).call("crm.deal.delete", { id: 1 }));
    const text = JSON.stringify((error as Bitrix24Error).toLogFields()) + String((error as Error).stack);
    expect(text).not.toContain(SECRET);
  });
});

describe("URL validation (same rules as the imbot webhook)", () => {
  it.each([
    ["http", "http://synthetic.bitrix24.test/rest/77/tok/"],
    ["a foreign host", "https://evil.example.com/rest/77/tok/"],
    ["a bad path", "https://synthetic.bitrix24.test/rest/tok/"],
    ["a query string", `${CRM_URL}?x=1`],
  ])("rejects %s", (_label, url) => {
    expect(() =>
      createBitrix24CrmClient({ baseUrl: url, portalDomains: PORTAL_DOMAINS, fetchImpl: forbiddenFetch() as never }),
    ).toThrow(Bitrix24ConfigError);
  });

  it("reports config errors under channels.bitrix24.crmWebhookUrl without echoing the URL", () => {
    let thrown: unknown;
    try {
      createBitrix24CrmClient({ baseUrl: "not a url", portalDomains: PORTAL_DOMAINS });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Bitrix24ConfigError);
    expect((thrown as Bitrix24ConfigError).configPath).toBe("channels.bitrix24.crmWebhookUrl");
  });

  it("describe() exposes only host and webhook user id", () => {
    expect(client({ fetchImpl: forbiddenFetch() }).describe()).toEqual({
      host: "synthetic.bitrix24.test",
      userId: "77",
    });
  });
});

describe("call path", () => {
  it("POSTs JSON to <webhook><method> and returns result, total and next", async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`${CRM_URL}crm.item.list`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(String(init?.body))).toEqual({ entityTypeId: 2 });
      return jsonResponse({ result: { items: [{ id: 1 }] }, total: 120, next: 50, time: {} });
    });
    const page = await client({ fetchImpl }).call("crm.item.list", { entityTypeId: 2 });
    expect(page).toEqual({ result: { items: [{ id: 1 }] }, total: 120, next: 50 });
  });

  it("a 200 without `result` is INVALID_RESPONSE", async () => {
    const crm = client({ fetchImpl: vi.fn(async () => jsonResponse({ total: 1 })) });
    await expect(crm.call("crm.category.list", {})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("a body that is not JSON is INVALID_RESPONSE on 200", async () => {
    const crm = client({ fetchImpl: vi.fn(async () => new Response("<html>", { status: 200 })) });
    await expect(crm.call("crm.category.list", {})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("counts every HTTP request, retries included, in the caller's stats", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1
        ? jsonResponse({ error: "QUERY_LIMIT_EXCEEDED", error_description: "Too many requests" }, 503)
        : jsonResponse({ result: [] });
    });
    const stats = { requests: 0 };
    await client({ fetchImpl }).call("crm.status.list", {}, { stats });
    expect(stats.requests).toBe(2);
  });
});

describe("paging", () => {
  function pagedFetch(totalRows: number) {
    return vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { start } = JSON.parse(String(init?.body)) as { start: number };
      const rows = Array.from({ length: Math.max(0, Math.min(50, totalRows - start)) }, (_, i) => ({ id: start + i + 1 }));
      const next = start + 50 < totalRows ? start + 50 : undefined;
      return jsonResponse({ result: { items: rows }, total: totalRows, ...(next === undefined ? {} : { next }) });
    });
  }

  it("follows `next` across pages with start 0, 50, 100", async () => {
    const fetchImpl = pagedFetch(120);
    const listed = await client({ fetchImpl }).list(
      "crm.item.list",
      { entityTypeId: 2 },
      (r) => (r as { items?: unknown[] }).items,
    );
    expect(listed.items).toHaveLength(120);
    expect(listed).toMatchObject({ total: 120, truncated: false, pages: 3 });
    const starts = fetchImpl.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { start: number }).start);
    expect(starts).toEqual([0, 50, 100]);
  });

  it(`stops at ${BITRIX24_CRM_MAX_PAGES} pages and reports truncated`, async () => {
    const fetchImpl = pagedFetch(5000);
    const listed = await client({ fetchImpl }).list("crm.item.list", {}, (r) => (r as { items?: unknown[] }).items);
    expect(fetchImpl).toHaveBeenCalledTimes(40);
    expect(listed).toMatchObject({ total: 5000, truncated: true, pages: 40 });
    expect(listed.items).toHaveLength(2000);
  });

  it("does not report truncated when the last page is exactly at the cap", async () => {
    const listed = await client({ fetchImpl: pagedFetch(2000) }).list(
      "crm.item.list",
      {},
      (r) => (r as { items?: unknown[] }).items,
    );
    expect(listed).toMatchObject({ truncated: false, pages: 40 });
  });

  it("a `next` that does not advance is INVALID_RESPONSE, never a loop", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { items: [{ id: 1 }] }, next: 0 }));
    await expect(
      client({ fetchImpl }).list("crm.item.list", {}, (r) => (r as { items?: unknown[] }).items),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a page without the row array is INVALID_RESPONSE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { nothing: true } }));
    await expect(
      client({ fetchImpl }).list("crm.item.list", {}, (r) => (r as { items?: unknown[] }).items),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("throttle: at most 2 requests per second", () => {
  it("spaces request starts at least 500 ms apart on a fake clock, also for concurrent callers", async () => {
    const clock = createScheduledClock(1_000_000);
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(clock.t);
      return jsonResponse({ result: [] });
    });
    const crm = createBitrix24CrmClient({
      baseUrl: CRM_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
    });
    await clock.run(Promise.all(Array.from({ length: 9 }, () => crm.call("crm.status.list", {}))));
    expect(starts[0]).toBe(1_000_000);
    expect(starts.at(-1)).toBe(1_000_000 + 8 * 500);
    expect(starts).toHaveLength(9);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(500);
    }
    for (const t of starts) {
      expect(starts.filter((s) => s >= t && s < t + 1000).length).toBeLessThanOrEqual(2);
    }
  });

  it("cannot be configured above 2 per second", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const crm = createBitrix24CrmClient({
      baseUrl: CRM_URL,
      portalDomains: PORTAL_DOMAINS,
      ratePerSec: 50,
      fetchImpl: (async () => {
        starts.push(clock.t);
        return jsonResponse({ result: [] });
      }) as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 4; i += 1) {
      await crm.call("crm.category.list", {});
    }
    expect(starts[3]! - starts[0]!).toBeGreaterThanOrEqual(1500);
  });
});

describe("retry and error mapping", () => {
  it.each([
    ["QUERY_LIMIT_EXCEEDED", 503],
    ["OPERATION_TIME_LIMIT", 429],
    ["QUERY_LIMIT_EXCEEDED", 200],
  ])("retries %s (HTTP %i) once with backoff, then succeeds", async (code, status) => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return n === 1 ? jsonResponse({ error: code, error_description: "limit" }, status) : jsonResponse({ result: [1] });
    });
    const clock = fakeClock();
    const crm = createBitrix24CrmClient({
      baseUrl: CRM_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
    });
    await expect(crm.call("crm.status.list", {})).resolves.toMatchObject({ result: [1] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toContain(1500);
  });

  it.each([
    ["QUERY_LIMIT_EXCEEDED", 503],
    ["OPERATION_TIME_LIMIT", 429],
  ])("gives up after exactly one retry on %s and reports that code", async (code, status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: code, error_description: "limit" }, status));
    await expect(client({ fetchImpl }).call("crm.item.list", {})).rejects.toMatchObject({ code, status });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([503, 429])("retries a bare HTTP %i once (reads are idempotent)", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("<html>busy</html>", { status }));
    await expect(client({ fetchImpl }).call("crm.category.list", {})).rejects.toMatchObject({ code: `http_${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["insufficient_scope", 401],
    ["insufficient_scope", 200],
    ["ACCESS_DENIED", 403],
    ["ACCESS_DENIED", 200],
    ["INVALID_CREDENTIALS", 401],
    ["", 401],
    ["", 403],
  ])("maps %j (HTTP %i) to ACCESS_DENIED without a retry", async (code, status) => {
    const body = code ? { error: code, error_description: "The request requires higher privileges" } : {};
    const fetchImpl = vi.fn(async () => jsonResponse(body, status));
    await expect(client({ fetchImpl }).call("crm.item.list", {})).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a tasks ERROR_CORE whose description says access denied to ACCESS_DENIED", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "ERROR_CORE", error_description: "TASKS_ERROR_EXCEPTION_#8; Access denied.; 256/TE/ACCESS_DENIED" }, 400),
    );
    await expect(client({ fetchImpl }).call("crm.status.list", {})).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("keeps another safe Bitrix code, never its description", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "ERROR_CORE", error_description: "Deal 'Secret merger' not found" }, 400),
    );
    let thrown: unknown;
    try {
      await client({ fetchImpl }).call("crm.item.list", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "ERROR_CORE", status: 400 });
    expect(JSON.stringify((thrown as Bitrix24Error).toLogFields())).not.toContain("Secret merger");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an unsafe code collapses to BITRIX_ERROR", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad code <script>" }, 400));
    await expect(client({ fetchImpl }).call("crm.item.list", {})).rejects.toMatchObject({ code: "BITRIX_ERROR" });
  });

  it("a transport failure is TRANSPORT_ERROR and is not retried", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed: ${CRM_URL}crm.item.list`);
    });
    let thrown: unknown;
    try {
      await client({ fetchImpl }).call("crm.item.list", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(String((thrown as Error).message) + JSON.stringify((thrown as Bitrix24Error).toLogFields())).not.toContain(SECRET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a request that outlives the timeout is TIMEOUT", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(client({ fetchImpl, timeoutMs: 20 }).call("crm.item.list", {})).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("uses a 60 s timeout by default and never more", async () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    try {
      await client({ fetchImpl: vi.fn(async () => jsonResponse({ result: [] })) }).call("crm.category.list", {});
      await client({ fetchImpl: vi.fn(async () => jsonResponse({ result: [] })), timeoutMs: 600_000 }).call("crm.category.list", {});
    } finally {
      spy.mockRestore();
    }
    expect(timeouts).toEqual([60_000, 60_000]);
  });

  it("an aborted caller signal stops before any request", async () => {
    const fetchImpl = forbiddenFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client({ fetchImpl }).call("crm.item.list", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("log hygiene", () => {
  it("logs method, attempt, outcome, counts and timing; never the URL, token or body", async () => {
    const log = captureLog();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({ error: "QUERY_LIMIT_EXCEEDED", error_description: "slow down" }, 503);
      }
      if (n === 2) {
        return jsonResponse({ result: { items: [{ id: 1, title: "Confidential deal" }] }, total: 1 });
      }
      return jsonResponse({ error: "ACCESS_DENIED", error_description: "no rights for Confidential" }, 403);
    });
    const crm = client({ fetchImpl, log });
    await crm.list("crm.item.list", {}, (r) => (r as { items?: unknown[] }).items);
    await crm.call("crm.status.list", {}).catch(() => undefined);
    const lines = log.all();
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).toContain("method=crm.item.list");
    expect(all).toContain("outcome=QUERY_LIMIT_EXCEEDED");
    expect(all).toContain("outcome=ACCESS_DENIED");
    expect(all).toContain("rows=1");
    for (const forbidden of [SECRET, "synthetic.bitrix24.test", "rest/77", "Confidential", "slow down"]) {
      expect(all).not.toContain(forbidden);
    }
  });
});
