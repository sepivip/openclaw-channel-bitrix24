// Channel-scoped reload: a change under channels.bitrix24.* restarts only this
// channel. The reload planner reads `reload.configPrefixes`; the gateway then
// stops the account (abort, `stopAccount`, the task settles) and starts it
// again with the new config.
//
// Driven through the real gateway adapter (`bitrix24Plugin.gateway`) against
// the fake Bitrix portal on an ephemeral loopback port. `runChannelInboundEvent`
// is mocked at the module boundary, as in integration.test.ts; the mock drives
// the adapter it is handed, so each reply really goes out through the plugin's
// own send.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  /** Raw text of every turn core was handed, in order. */
  turns: [] as string[],
  /** When set, a turn waits on it after being recorded: a turn in flight. */
  hold: undefined as Promise<void> | undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (input: unknown, eventClass: unknown, preflight: unknown) => Promise<{
          route: { sessionKey: string };
          ctxPayload: unknown;
          delivery: {
            deliverWithProviderMessageSending: (
              payload: { text: string },
              info: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        }>;
      };
    }) => {
      const input = (await params.adapter.ingest(params.raw)) as { rawText?: string };
      harness.turns.push(input.rawText ?? "");
      await harness.hold;
      const plan = await params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      await plan.delivery.deliverWithProviderMessageSending(
        { text: `re: ${input.rawText ?? ""}` },
        {
          kind: "final",
          assertPlatformSendAuthorized: () => {},
          onPlatformSendDispatch: async () => {},
        },
      );
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

import { resolveBitrix24Account } from "../src/config-schema.js";
import {
  bitrix24Plugin,
  getRunningBitrix24AccountRuntime,
  inspectRunningBitrix24Account,
} from "../src/plugin.js";
import { BITRIX24_STATE_KEY_OFFSET, createFileStateStore } from "../src/state-store.js";

const { createFakeBitrix } = (await import("./fake-bitrix/server.mjs")) as {
  createFakeBitrix: (options?: Record<string, unknown>) => {
    state: {
      sent: Array<{ dialogId: string; message: string }>;
      calls: Array<{ method: string; at: number }>;
      acks: number[];
    };
    listen: () => Promise<{ origin: string; restBase: string }>;
    close: () => Promise<void>;
  };
};

const BOT_TOKEN = "faketoken";
/** Idle and active poll interval: one loop never polls faster than this. */
const POLL_MS = 100;

let fake: ReturnType<typeof createFakeBitrix>;
let origin: string;
let restBase: string;

type Run = { abort: AbortController; ctx: never; task: Promise<unknown> };
const runs: Run[] = [];

function lifecycle() {
  const gateway = bitrix24Plugin.gateway;
  if (!gateway?.startAccount || !gateway.stopAccount) {
    throw new Error("bitrix24Plugin.gateway has no startAccount/stopAccount");
  }
  return { startAccount: gateway.startAccount, stopAccount: gateway.stopAccount };
}

function buildConfig(): never {
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
        dmPolicy: "allowlist",
        allowFrom: ["42"],
        groupPolicy: "disabled",
        allowInsecureHttpForTests: true,
        bot: { code: "reload_bot", name: "Assistant", color: "PURPLE", workPosition: "AI Assistant" },
        poll: { idleMs: POLL_MS, activeMs: POLL_MS },
      },
    },
  } as never;
}

/** `startAccount` as the gateway calls it; the task is the account's long-lived promise. */
function start(accountId: string): Run {
  const abort = new AbortController();
  const cfg = buildConfig();
  const ctx = {
    cfg,
    accountId,
    account: resolveBitrix24Account(cfg, accountId),
    abortSignal: abort.signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setStatus: () => {},
  } as never;
  const run = { abort, ctx, task: lifecycle().startAccount(ctx) as Promise<unknown> };
  runs.push(run);
  return run;
}

/** The gateway's stop order: abort the account, run `stopAccount`, then the task settles. */
async function stop(run: Run): Promise<void> {
  run.abort.abort();
  await lifecycle().stopAccount(run.ctx);
  await run.task;
}

async function enqueue(text: string): Promise<number> {
  const response = await fetch(`${origin}/__test/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: 42, text }),
  });
  return ((await response.json()) as { eventId: number }).eventId;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistedOffset(accountId: string): Promise<string | undefined> {
  return await createFileStateStore({ accountId }).get(BITRIX24_STATE_KEY_OFFSET);
}

const callsTo = (method: string) => fake.state.calls.filter((call) => call.method === method);
const sentText = () => fake.state.sent.map((sent) => sent.message);

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
  harness.turns.length = 0;
  harness.hold = undefined;
  await fetch(`${origin}/__test/reset`, { method: "POST", body: "{}" });
});

afterEach(async () => {
  // A failed test must not leave a poll loop running into the next one.
  harness.hold = undefined;
  for (const run of runs.splice(0)) {
    if (!run.abort.signal.aborted) {
      await stop(run);
    }
  }
});

describe("reload declaration", () => {
  it("declares exactly reload.configPrefixes ['channels.bitrix24']", () => {
    // The whole object: no accountScopedRestart (single-account config) and
    // no noopPrefixes, so every channels.bitrix24.* change restarts the channel.
    expect(bitrix24Plugin.reload).toEqual({ configPrefixes: ["channels.bitrix24"] });
  });
});

describe("channel restart (start -> stop -> start)", () => {
  it("resumes from the persisted offset with exactly one poll loop; the runtime is unset in between", async () => {
    const accountId = "restart-cycle";
    const first = await enqueue("before restart");

    const runA = start(accountId);
    await waitFor(() => fake.state.sent.length >= 1);
    expect(getRunningBitrix24AccountRuntime(accountId)).toMatchObject({ botId: "777" });

    await stop(runA);
    // Between stop and start: no running runtime for the send-sheet tool, the
    // offset is on disk, and the old loop no longer polls.
    expect(getRunningBitrix24AccountRuntime(accountId)).toBeUndefined();
    expect(inspectRunningBitrix24Account(accountId)).toBeUndefined();
    expect(await persistedOffset(accountId)).toBe(String(first + 1));
    const pollsWhileStopped = callsTo("imbot.v2.Event.get").length;
    await delay(POLL_MS * 4);
    expect(callsTo("imbot.v2.Event.get")).toHaveLength(pollsWhileStopped);

    await enqueue("while stopped");
    const acksBefore = fake.state.acks.length;
    const registersBefore = callsTo("imbot.v2.Bot.register").length;
    const runB = start(accountId);
    await waitFor(() => fake.state.sent.length >= 2);
    // The first Event.get after the restart carried the persisted offset, so
    // "before restart" was not replayed.
    expect(fake.state.acks[acksBefore]).toBe(first + 1);
    expect(harness.turns).toEqual(["before restart", "while stopped"]);
    expect(sentText()).toEqual(["re: before restart", "re: while stopped"]);
    // Bot.register ran again and returned the same bot.
    expect(callsTo("imbot.v2.Bot.register")).toHaveLength(registersBefore + 1);
    expect(getRunningBitrix24AccountRuntime(accountId)).toMatchObject({ botId: "777" });

    // A second start while running hands back the same account: no second
    // registration, no second loop.
    const duplicate = start(accountId);

    // Exactly one poll loop: consecutive Event.get calls stay a poll interval
    // apart. Two loops would interleave, and one gap would be at most half.
    const from = callsTo("imbot.v2.Event.get").length;
    await delay(POLL_MS * 8);
    const times = callsTo("imbot.v2.Event.get")
      .slice(from)
      .map((call) => call.at);
    expect(times.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(POLL_MS * 0.75);
    }
    expect(callsTo("imbot.v2.Bot.register")).toHaveLength(registersBefore + 1);

    await stop(runB);
    duplicate.abort.abort();
    await duplicate.task;
    expect(getRunningBitrix24AccountRuntime(accountId)).toBeUndefined();
  });

  it("a stop mid-batch waits for the turn in flight only; the restart handles the rest", async () => {
    const accountId = "restart-mid-batch";
    let release: () => void = () => {};
    harness.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await enqueue("one");
    const two = await enqueue("two");
    const three = await enqueue("three");

    const runA = start(accountId);
    await waitFor(() => harness.turns.length >= 1); // "one" is in flight

    let stopped = false;
    const stopping = stop(runA).then(() => {
      stopped = true;
    });
    await delay(POLL_MS * 2);
    expect(stopped).toBe(false); // the turn in flight is not abandoned
    harness.hold = undefined;
    release();
    await stopping;

    // Only "one" was handed over, its reply still went out after the stop
    // began, and only it is acknowledged: the offset is the id of "two".
    expect(harness.turns).toEqual(["one"]);
    expect(sentText()).toEqual(["re: one"]);
    expect(await persistedOffset(accountId)).toBe(String(two));

    const runB = start(accountId);
    await waitFor(() => fake.state.sent.length >= 3);
    expect(harness.turns).toEqual(["one", "two", "three"]);
    expect(sentText()).toEqual(["re: one", "re: two", "re: three"]);
    await stop(runB);
    expect(await persistedOffset(accountId)).toBe(String(three + 1));
  });
});
