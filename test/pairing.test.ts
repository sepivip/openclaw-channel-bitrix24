// dmPolicy "pairing": the pairing request is stored through the Gateway's
// injected pairing writer (`PluginRuntime["channel"]["pairing"]
// ["upsertPairingRequest"]`), not through the deprecated
// `openclaw/plugin-sdk/conversation-runtime` barrel.
//
// In 2026.9.4 that runtime method forwards { channel, id, accountId, meta } to
// the same `upsertChannelPairingRequest` the barrel exported, so the request
// the store receives is unchanged: the argument assertions below are the ones
// the barrel call satisfied before the migration. Without a Gateway runtime
// the challenge fails closed: nothing is stored and no code is sent.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Guard: the deprecated barrel's pairing writer must not be reached again.
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertChannelPairingRequest: () => {
    throw new Error("the deprecated conversation-runtime pairing writer was called");
  },
}));

import { resolveBitrix24Account, resetBitrix24ConfigNotices } from "../src/config-schema.js";
import { handleBitrix24InboundEvent } from "../src/inbound.js";
import { bitrix24Plugin, setBitrix24Runtime } from "../src/plugin.js";
import { OUTSIDER, buildConfig, buildDeps, dmEvent } from "./fixtures.js";

type UpsertParams = { channel: string; id: string; accountId: string; meta?: Record<string, string> };

function pairingWriter(result: { code: string; created: boolean }) {
  return vi.fn(async (_params: UpsertParams) => result);
}

beforeEach(() => {
  resetBitrix24ConfigNotices();
});

describe("pairing challenge (inbound path)", () => {
  it("stores the request through the injected writer with the pre-migration arguments and sends the code", async () => {
    const upsert = pairingWriter({ code: "PAIRCODE1", created: true });
    const { deps, sent } = buildDeps(buildConfig({ dmPolicy: "pairing" }));
    Object.assign(deps, { upsertPairingRequest: upsert });

    const outcome = await handleBitrix24InboundEvent({ deps, raw: dmEvent({ userId: OUTSIDER }) });

    expect(outcome).toEqual({ status: "dropped", reason: "pairing" });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith({
      channel: "bitrix24",
      id: String(OUTSIDER),
      accountId: "default",
      meta: { name: "Synthetic User" },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.dialogId).toBe(String(OUTSIDER));
    expect(sent[0]?.message).toContain("PAIRCODE1");
    expect(sent[0]?.message).toContain(`Your Bitrix24 user id: ${OUTSIDER}`);
  });

  it("sends nothing when the request already existed (created: false)", async () => {
    const upsert = pairingWriter({ code: "PAIRCODE1", created: false });
    const { deps, sent, calls } = buildDeps(buildConfig({ dmPolicy: "pairing" }));
    Object.assign(deps, { upsertPairingRequest: upsert });

    const outcome = await handleBitrix24InboundEvent({ deps, raw: dmEvent({ userId: OUTSIDER }) });

    expect(outcome).toEqual({ status: "dropped", reason: "pairing" });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("fails closed without a Gateway pairing writer: nothing stored, nothing sent, a warning", async () => {
    const { deps, sent, calls, log } = buildDeps(buildConfig({ dmPolicy: "pairing" }));

    const outcome = await handleBitrix24InboundEvent({ deps, raw: dmEvent({ userId: OUTSIDER }) });

    expect(outcome).toEqual({ status: "dropped", reason: "pairing" });
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[bitrix24] pairing challenge failed"));
  });
});

// ---------------------------------------------------------------------------
// Wiring: `startAccount` hands the Gateway runtime's pairing writer to the
// inbound handler. Real gateway adapter against the fake portal.
// ---------------------------------------------------------------------------

const { createFakeBitrix } = (await import("./fake-bitrix/server.mjs")) as {
  createFakeBitrix: (options?: Record<string, unknown>) => {
    state: { sent: Array<{ dialogId: string; message: string }> };
    listen: () => Promise<{ origin: string; restBase: string }>;
    close: () => Promise<void>;
  };
};

const BOT_TOKEN = "faketoken";
const POLL_MS = 100;
let fake: ReturnType<typeof createFakeBitrix>;
let origin: string;
let restBase: string;
const running: Array<{ abort: AbortController; ctx: never; task: Promise<unknown> }> = [];

function gatewayConfig(): never {
  return {
    bindings: [
      { type: "route", agentId: "bitrix24-assistant", match: { channel: "bitrix24", accountId: "*" } },
    ],
    agents: { entries: { main: { name: "Main" }, "bitrix24-assistant": { name: "Assistant" } } },
    channels: {
      bitrix24: {
        enabled: true,
        webhookUrl: restBase,
        botToken: BOT_TOKEN,
        portalDomain: "127.0.0.1",
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        allowInsecureHttpForTests: true,
        bot: { code: "pairing_bot", name: "Assistant", color: "PURPLE", workPosition: "AI Assistant" },
        poll: { idleMs: POLL_MS, activeMs: POLL_MS },
      },
    },
  } as never;
}

function startAccount(accountId: string, channelRuntime?: unknown) {
  const gateway = bitrix24Plugin.gateway;
  if (!gateway?.startAccount) {
    throw new Error("bitrix24Plugin.gateway has no startAccount");
  }
  const abort = new AbortController();
  const cfg = gatewayConfig();
  const ctx = {
    cfg,
    accountId,
    account: resolveBitrix24Account(cfg, accountId),
    abortSignal: abort.signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setStatus: () => {},
    ...(channelRuntime ? { channelRuntime } : {}),
  } as never;
  const run = { abort, ctx, task: gateway.startAccount(ctx) as Promise<unknown> };
  running.push(run);
  return run;
}

async function enqueueDm(userId: number, text: string): Promise<void> {
  await fetch(`${origin}/__test/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, text }),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("pairing challenge (startAccount wiring)", () => {
  beforeAll(async () => {
    fake = createFakeBitrix({ botToken: BOT_TOKEN });
    const listening = await fake.listen();
    origin = listening.origin;
    restBase = listening.restBase;
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    await fetch(`${origin}/__test/reset`, { method: "POST", body: "{}" });
  });

  afterEach(async () => {
    setBitrix24Runtime(undefined);
    const gateway = bitrix24Plugin.gateway;
    for (const run of running.splice(0)) {
      run.abort.abort();
      await gateway?.stopAccount?.(run.ctx);
      await run.task;
    }
  });

  it("uses ctx.channelRuntime.pairing.upsertPairingRequest", async () => {
    const upsert = pairingWriter({ code: "CTXCODE1", created: true });
    startAccount("pairing-ctx", { pairing: { upsertPairingRequest: upsert } });
    await enqueueDm(4242, "hello");
    await waitFor(() => fake.state.sent.length >= 1);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "bitrix24", id: "4242", accountId: "pairing-ctx" }),
    );
    expect(fake.state.sent[0]?.dialogId).toBe("4242");
    expect(fake.state.sent[0]?.message).toContain("CTXCODE1");
  });

  it("falls back to the runtime handed to setRuntime", async () => {
    const upsert = pairingWriter({ code: "RTCODE01", created: true });
    setBitrix24Runtime({ channel: { pairing: { upsertPairingRequest: upsert } } });
    startAccount("pairing-runtime");
    await enqueueDm(4243, "hello");
    await waitFor(() => fake.state.sent.length >= 1);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "bitrix24", id: "4243", accountId: "pairing-runtime" }),
    );
    expect(fake.state.sent[0]?.message).toContain("RTCODE01");
  });
});
