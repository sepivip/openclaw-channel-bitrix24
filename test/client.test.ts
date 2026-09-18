import { describe, expect, it, vi } from "vitest";
import {
  BITRIX24_METHOD_ALLOWLIST,
  assertAllowedBitrix24Method,
  createBitrix24Client,
  validateBitrix24BaseUrl,
} from "../src/client.js";
import { Bitrix24ConfigError, Bitrix24Error } from "../src/secrets.js";

const PORTAL_DOMAINS = ["example.bitrix24.eu"];
const GOOD_URL = "https://acme.example.bitrix24.eu/rest/42/s3cr3tT0kenAAAA/";

/** Fails the test if any network call is attempted. */
function forbiddenFetch(): typeof fetch {
  return (() => {
    throw new Error("network call attempted in a unit test");
  }) as unknown as typeof fetch;
}

describe("method allowlist", () => {
  it("accepts exactly the five imbot.v2 methods", () => {
    expect([...BITRIX24_METHOD_ALLOWLIST]).toEqual([
      "imbot.v2.Bot.register",
      "imbot.v2.Bot.update",
      "imbot.v2.Event.get",
      "imbot.v2.Chat.Message.send",
      "imbot.v2.Chat.InputAction.notify",
    ]);
    for (const method of BITRIX24_METHOD_ALLOWLIST) {
      expect(() => assertAllowedBitrix24Method(method)).not.toThrow();
    }
  });

  it("rejects crm.deal.list SYNCHRONOUSLY, before any request", () => {
    const client = createBitrix24Client({
      baseUrl: GOOD_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: forbiddenFetch(),
    });
    // Not `rejects`: `call` must throw, not return a rejected promise.
    let thrown: unknown;
    try {
      client.call("crm.deal.list", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Bitrix24Error);
    expect((thrown as Bitrix24Error).code).toBe("METHOD_NOT_ALLOWED");
  });

  it.each([
    "crm.deal.delete",
    "disk.storage.uploadfile",
    "user.current",
    "tasks.task.list",
    "calendar.event.get",
    "imbot.message.add",
    "imbot.v2.Chat.Message.send ",
  ])("rejects %s", (method) => {
    expect(() => assertAllowedBitrix24Method(method)).toThrow(Bitrix24Error);
  });

  it("never leaks the webhook token in the allowlist error", () => {
    try {
      assertAllowedBitrix24Method("crm.deal.list");
    } catch (error) {
      expect(JSON.stringify(error instanceof Bitrix24Error ? error.toLogFields() : {})).not.toContain(
        "s3cr3tT0kenAAAA",
      );
    }
  });
});

describe("base URL validation", () => {
  it("accepts a well-formed https portal webhook URL", () => {
    const result = validateBitrix24BaseUrl({ url: GOOD_URL, portalDomains: PORTAL_DOMAINS });
    expect(result.host).toBe("acme.example.bitrix24.eu");
    expect(result.userId).toBe("42");
    expect(result.baseUrl.endsWith("/")).toBe(true);
  });

  it("rejects http:", () => {
    expect(() =>
      validateBitrix24BaseUrl({
        url: "http://acme.example.bitrix24.eu/rest/42/s3cr3tT0kenAAAA/",
        portalDomains: PORTAL_DOMAINS,
      }),
    ).toThrow(Bitrix24ConfigError);
  });

  it("rejects a host outside the configured portal domain", () => {
    expect(() =>
      validateBitrix24BaseUrl({
        url: "https://evil.example.com/rest/42/s3cr3tT0kenAAAA/",
        portalDomains: PORTAL_DOMAINS,
      }),
    ).toThrow(/portalDomain/);
  });

  it("rejects a lookalike suffix host", () => {
    expect(() =>
      validateBitrix24BaseUrl({
        url: "https://notexample.bitrix24.eu.evil.com/rest/42/s3cr3tT0kenAAAA/",
        portalDomains: PORTAL_DOMAINS,
      }),
    ).toThrow(Bitrix24ConfigError);
  });

  it.each([
    "https://acme.example.bitrix24.eu/",
    "https://acme.example.bitrix24.eu/rest/",
    "https://acme.example.bitrix24.eu/rest/42/",
    "https://acme.example.bitrix24.eu/restx/42/tok/",
    "https://acme.example.bitrix24.eu/rest/abc/tok/",
  ])("rejects malformed path %s", (url) => {
    expect(() => validateBitrix24BaseUrl({ url, portalDomains: PORTAL_DOMAINS })).toThrow(
      Bitrix24ConfigError,
    );
  });

  it("rejects a query string, a fragment and embedded userinfo", () => {
    for (const url of [
      `${GOOD_URL}?x=1`,
      `${GOOD_URL}#frag`,
      "https://u:p@acme.example.bitrix24.eu/rest/42/s3cr3tT0kenAAAA/",
    ]) {
      expect(() => validateBitrix24BaseUrl({ url, portalDomains: PORTAL_DOMAINS })).toThrow(
        Bitrix24ConfigError,
      );
    }
  });

  it("refuses when no portal domain is configured (never undefined ⇒ accept)", () => {
    expect(() => validateBitrix24BaseUrl({ url: GOOD_URL, portalDomains: [] })).toThrow(
      /portalDomain is not configured/,
    );
  });

  it("rejects a missing URL", () => {
    expect(() => validateBitrix24BaseUrl({ url: undefined, portalDomains: PORTAL_DOMAINS })).toThrow(
      Bitrix24ConfigError,
    );
  });
});

describe("client call path", () => {
  it("posts to baseUrl + method and unwraps `result`", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe(`${GOOD_URL}imbot.v2.Event.get`);
      return new Response(JSON.stringify({ result: { events: [], hasMore: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createBitrix24Client({
      baseUrl: GOOD_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.call<{ events: unknown[] }>("imbot.v2.Event.get", { limit: 100 });
    expect(result.events).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("wraps a Bitrix error envelope into Bitrix24Error with no URL anywhere", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "BOT_TOKEN_NOT_SPECIFIED",
            error_description: "Bot token is required",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createBitrix24Client({
      baseUrl: GOOD_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(client.call("imbot.v2.Event.get", {})).rejects.toBeInstanceOf(Bitrix24Error);
    try {
      await client.call("imbot.v2.Event.get", {});
    } catch (error) {
      const wrapped = error as Bitrix24Error;
      expect(wrapped.code).toBe("BOT_TOKEN_NOT_SPECIFIED");
      const serialized = JSON.stringify(wrapped.toLogFields()) + wrapped.message + wrapped.stack;
      expect(serialized).not.toContain("s3cr3tT0kenAAAA");
      expect(serialized).not.toContain("acme.example.bitrix24.eu");
    }
  });

  it("backs off and retries on QUERY_LIMIT_EXCEEDED then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: "QUERY_LIMIT_EXCEEDED", error_description: "too fast" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const sleeps: number[] = [];
    const client = createBitrix24Client({
      baseUrl: GOOD_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });
    await expect(client.call("imbot.v2.Chat.Message.send", {})).resolves.toBe("ok");
    expect(calls).toBe(2);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("retries OPERATION_TIME_LIMIT (429) and gives up after maxRetries", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "OPERATION_TIME_LIMIT", error_description: "slow down" }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createBitrix24Client({
      baseUrl: GOOD_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      sleep: async () => {},
      random: () => 0.5,
    });
    await expect(client.call("imbot.v2.Event.get", {})).rejects.toMatchObject({
      code: "OPERATION_TIME_LIMIT",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("describe() exposes only host and webhook user id", () => {
    const client = createBitrix24Client({
      baseUrl: GOOD_URL,
      portalDomains: PORTAL_DOMAINS,
      fetchImpl: forbiddenFetch(),
    });
    expect(client.describe()).toEqual({ host: "acme.example.bitrix24.eu", userId: "42" });
  });
});
