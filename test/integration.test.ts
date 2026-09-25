// Offline end-to-end coverage: the real poller and the real inbound path driven
// against the fake Bitrix portal on an ephemeral loopback port.
//
// Covers design §6 T-4 (allowlist deny), T-6 (loop guard), T-7 (method
// allowlist), T-9 (chunking) and T-10 (offset survives restart).
//
// `runChannelInboundEvent` is mocked at the module boundary — that is the exact
// seam where a real Gateway would take over. The mock still drives the adapter
// it was handed (`ingest` → `resolveTurn` → `delivery.
// deliverWithProviderMessageSending`), so everything the plugin owns runs for
// real: routing, context build, reply pipeline, BB conversion, chunking and the
// HTTP send.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TurnCall = {
  channel: string;
  accountId?: string;
  agentId: string;
  sessionKey: string;
  rawText: string;
  deliveredMessageIds: string[];
};

const harness = vi.hoisted(() => ({
  /** Text the fake agent "replies" with; undefined means no reply payload. */
  replyText: undefined as string | undefined,
  calls: [] as TurnCall[],
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  // Minimal stand-in for the core context builder: the plugin only needs the
  // object to be carried through to the turn plan.
  buildChannelInboundEventContext: (params: Record<string, unknown>) => ({
    ...params,
    SessionKey: (params.route as { routeSessionKey?: string } | undefined)?.routeSessionKey ?? "",
  }),
  runChannelInboundEvent: async (params: {
    channel: string;
    accountId?: string;
    raw: unknown;
    adapter: {
      ingest: (raw: unknown) => unknown;
      resolveTurn: (input: unknown, eventClass: unknown, preflight: unknown) => Promise<{
        route: { agentId: string; sessionKey: string };
        ctxPayload: unknown;
        delivery: {
          deliverWithProviderMessageSending: (
            payload: { text: string },
            info: Record<string, unknown>,
          ) => Promise<{ messageIds?: string[] } | void>;
        };
      }>;
    };
  }) => {
    const input = (await params.adapter.ingest(params.raw)) as { rawText?: string };
    const plan = await params.adapter.resolveTurn(
      input,
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    let deliveredMessageIds: string[] = [];
    if (harness.replyText !== undefined) {
      const result = await plan.delivery.deliverWithProviderMessageSending(
        { text: harness.replyText },
        {
          kind: "final",
          assertPlatformSendAuthorized: () => {},
          onPlatformSendDispatch: async () => {},
        },
      );
      deliveredMessageIds = (result as { messageIds?: string[] } | undefined)?.messageIds ?? [];
    }
    harness.calls.push({
      channel: params.channel,
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
      agentId: plan.route.agentId,
      sessionKey: plan.route.sessionKey,
      rawText: input.rawText ?? "",
      deliveredMessageIds,
    });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult: {},
    };
  },
}));

const { createFakeBitrix } = (await import("./fake-bitrix/server.mjs")) as {
  createFakeBitrix: (options?: Record<string, unknown>) => {
    state: {
      sent: Array<{ dialogId: string; message: string; botId: string }>;
      calls: Array<{ method: string }>;
      acks: number[];
      events: unknown[];
    };
    counts: () => Record<string, number>;
    listen: () => Promise<{ origin: string; restBase: string; port: number }>;
    close: () => Promise<void>;
  };
};

const { createBitrix24Client, BITRIX24_METHOD_ALLOWLIST } = await import("../src/client.js");
const { createBitrix24EventHandler } = await import("../src/inbound.js");
const { createBitrix24Poller } = await import("../src/poller.js");
const { createFileStateStore, BITRIX24_STATE_KEY_OFFSET } = await import("../src/state-store.js");
const { registerBitrix24Bot } = await import("../src/plugin.js");
const { resolveBitrix24Account } = await import("../src/config-schema.js");

const BOT_TOKEN = "faketoken";
const REST_SECRET = "FAKEFAKEFAKE";
const PORTAL_DOMAIN = "127.0.0.1";

let fake: ReturnType<typeof createFakeBitrix>;
let restBase: string;
let origin: string;
let stateDir: string;

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    bindings: [
      {
        type: "route",
        agentId: "bitrix24-assistant",
        match: { channel: "bitrix24", accountId: "*" },
      },
    ],
    agents: {
      entries: {
        main: { name: "Main" },
        "bitrix24-assistant": { name: "Assistant" },
      },
    },
    channels: {
      bitrix24: {
        enabled: true,
        webhookUrl: restBase,
        botToken: BOT_TOKEN,
        portalDomain: PORTAL_DOMAIN,
        dmPolicy: "allowlist",
        allowFrom: ["42"],
        groupPolicy: "disabled",
        allowInsecureHttpForTests: true,
        bot: {
          code: "openclaw_bot",
          name: "Assistant",
          color: "PURPLE",
          workPosition: "AI Assistant",
        },
        poll: { idleMs: 1000, activeMs: 50 },
        ...overrides,
      },
    },
  } as never;
}

function buildClient() {
  return createBitrix24Client({
    baseUrl: restBase,
    portalDomains: [PORTAL_DOMAIN],
    allowInsecureHttpForTests: true,
    ratePerSec: 200,
    burst: 200,
  });
}

async function control(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return await response.json();
}

/** Drive one poller until `predicate` holds or the deadline passes. */
async function runPollerUntil(params: {
  client: ReturnType<typeof buildClient>;
  botId: string;
  cfg: unknown;
  accountId?: string;
  stateStore: Awaited<ReturnType<typeof createFileStateStore>>;
  predicate: () => boolean;
  timeoutMs?: number;
}): Promise<ReturnType<ReturnType<typeof createBitrix24Poller>["snapshot"]>> {
  const accountId = params.accountId ?? "default";
  const cfg = params.cfg as never;
  const poller = createBitrix24Poller({
    client: params.client,
    accountId,
    botId: params.botId,
    botToken: BOT_TOKEN,
    stateStore: params.stateStore,
    idleMs: 25,
    activeMs: 10,
    onEvents: createBitrix24EventHandler({
      getConfig: () => cfg,
      getAccount: () => resolveBitrix24Account(cfg, accountId),
      accountId,
      client: params.client,
      getBotId: () => params.botId,
      botToken: BOT_TOKEN,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }),
  });
  poller.start();
  const deadline = Date.now() + (params.timeoutMs ?? 6000);
  while (Date.now() < deadline && !params.predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const snapshot = poller.snapshot();
  await poller.stop();
  return snapshot;
}

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "bitrix24-it-"));
  fake = createFakeBitrix({ botToken: BOT_TOKEN, secret: REST_SECRET, userId: "1" });
  const listening = await fake.listen();
  origin = listening.origin;
  restBase = listening.restBase;
});

afterAll(async () => {
  await fake.close();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(async () => {
  harness.calls.length = 0;
  harness.replyText = undefined;
  await control("/__test/reset", {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Bot.register (idempotent by code)", () => {
  it("registers with eventMode fetch and returns the numeric bot id", async () => {
    const client = buildClient();
    const account = resolveBitrix24Account(buildConfig(), "default");
    const first = await registerBitrix24Bot({
      client,
      botToken: BOT_TOKEN,
      bot: account.bot,
    });
    const second = await registerBitrix24Bot({
      client,
      botToken: BOT_TOKEN,
      bot: account.bot,
    });
    expect(first).toBe("777");
    expect(second).toBe(first);
  });

  it("refuses the wrong botToken with a Bitrix error object, never a raw URL", async () => {
    const client = buildClient();
    await expect(
      client.call("imbot.v2.Event.get", { botId: 777, botToken: "wrong-token" }),
    ).rejects.toMatchObject({ name: "Bitrix24Error", code: "BOT_OWNERSHIP_ERROR" });
  });
});

describe("T-4 allowlist deny", () => {
  it("drops a DM from a user that is not in allowFrom: no dispatch, no send", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "t4", stateDir });
    await control("/__test/enqueue", { userId: 999, text: "let me in" });

    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t4",
      stateStore,
      // Wait for the event to have been fetched and acknowledged.
      predicate: () => fake.state.acks.length > 0,
    });

    expect(harness.calls).toHaveLength(0);
    expect(fake.state.sent).toHaveLength(0);
  });

  it("admits a DM from an allowlisted user and routes it via bindings", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "t4b", stateDir });
    harness.replyText = "pong";
    await control("/__test/enqueue", { userId: 42, text: "ping" });

    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t4b",
      stateStore,
      predicate: () => harness.calls.length > 0,
    });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({
      channel: "bitrix24",
      accountId: "t4b",
      agentId: "bitrix24-assistant",
      rawText: "ping",
    });
    expect(harness.calls[0]?.sessionKey).toBeTruthy();
    // deliverWithProviderMessageSending reached our sendText.
    expect(fake.state.sent).toEqual([
      expect.objectContaining({ dialogId: "42", message: "pong", botId: "777" }),
    ]);
  });
});

describe("T-6 loop guard", () => {
  it("drops the bot's own echo before ingress", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "t6", stateDir });
    // authorId === botId, and the sender is flagged as a bot.
    await control("/__test/enqueue", {
      userId: 777,
      authorId: 777,
      isBot: true,
      text: "pong",
      dialogId: "42",
    });

    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t6",
      stateStore,
      predicate: () => fake.state.acks.length > 0,
    });

    expect(harness.calls).toHaveLength(0);
    expect(fake.state.sent).toHaveLength(0);
  });
});

describe("T-7 method allowlist", () => {
  it("only ever calls the five allowlisted imbot.v2 methods", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "t7", stateDir });
    harness.replyText = "ok";
    await registerBitrix24Bot({
      client,
      botToken: BOT_TOKEN,
      bot: resolveBitrix24Account(buildConfig(), "default").bot,
    });
    await control("/__test/enqueue", { userId: 42, text: "hello" });
    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t7",
      stateStore,
      predicate: () => fake.state.sent.length > 0,
    });

    const observed = new Set(fake.state.calls.map((call) => call.method));
    expect(observed.size).toBeGreaterThan(0);
    for (const method of observed) {
      expect(BITRIX24_METHOD_ALLOWLIST as readonly string[]).toContain(method);
    }
    // Nothing outside imbot.v2 was even attempted.
    for (const method of observed) {
      expect(method.startsWith("imbot.v2.")).toBe(true);
    }
  });

  it("throws synchronously for any method outside the allowlist", () => {
    const client = buildClient();
    for (const method of ["crm.deal.list", "user.current", "disk.storage.uploadfile", "tasks.task.list", "calendar.event.get"]) {
      expect(() => client.call(method, {})).toThrow(/METHOD_NOT_ALLOWED/);
      try {
        client.call(method, {});
      } catch (error) {
        expect((error as { description: string }).description).toContain(
          "not on the Bitrix24 bridge allowlist",
        );
      }
    }
  });
});

describe("T-9 chunking", () => {
  it("splits a 12 000-character reply into three Message.send calls", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "t9", stateDir });
    // No whitespace, so every cut lands on the 4 000-char hard limit.
    harness.replyText = "a".repeat(12_000);
    await control("/__test/enqueue", { userId: 42, text: "long please" });

    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t9",
      stateStore,
      predicate: () => harness.calls.length > 0,
    });

    expect(fake.state.sent).toHaveLength(3);
    for (const sent of fake.state.sent) {
      expect(sent.message.length).toBeLessThanOrEqual(4000);
      expect(sent.dialogId).toBe("42");
    }
    expect(fake.state.sent.map((s) => s.message).join("")).toHaveLength(12_000);
    expect(harness.calls[0]?.deliveredMessageIds).toHaveLength(3);
  });

  it("keeps BB tags balanced across a chunk boundary", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "t9b", stateDir });
    harness.replyText = `${"word ".repeat(1000)}**bold tail**`;
    await control("/__test/enqueue", { userId: 42, text: "formatted" });

    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t9b",
      stateStore,
      predicate: () => harness.calls.length > 0,
    });

    const joined = fake.state.sent.map((s) => s.message).join("\n");
    expect(joined).toContain("[b]bold tail[/b]");
    for (const sent of fake.state.sent) {
      // No chunk may end mid-tag.
      expect(sent.message).not.toMatch(/\[[^\]]*$/);
    }
  });
});

describe("group chats end to end (poller -> guard -> ingress -> send)", () => {
  /** A group ONIMBOTV2MESSAGEADD as raw JSON for the fake portal. Synthetic values. */
  function rawGroupMessage(params: { userId: number; text: string; dialogId?: string }) {
    const dialogId = params.dialogId ?? "chat5";
    return {
      type: "ONIMBOTV2MESSAGEADD",
      date: new Date().toISOString(),
      data: {
        bot: { id: 777, code: "openclaw_bot" },
        message: { id: 1, chatId: 5, authorId: params.userId, text: params.text, isSystem: false },
        chat: {
          id: 5,
          dialogId,
          name: "Fake Group",
          type: "chat",
          messageType: "C",
          extranet: false,
          containsCollaber: false,
          entityType: "",
        },
        user: {
          id: params.userId,
          name: "Fake User",
          bot: false,
          extranet: false,
          connector: false,
          externalAuthId: "default",
        },
      },
    };
  }

  const groupCfg = () => buildConfig({ groupPolicy: "allowlist", groups: { chat5: {} } });

  it("answers a mention from an allowlisted user in the group, ignores the rest", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "grp", stateDir });
    harness.replyText = "group pong";
    // 1. mentioned + allowlisted  -> answered
    await control("/__test/enqueue", {
      raw: rawGroupMessage({ userId: 42, text: "[USER=777]Test Bot[/USER] ping" }),
    });
    // 2. not mentioned            -> ignored
    await control("/__test/enqueue", { raw: rawGroupMessage({ userId: 42, text: "just chatting" }) });
    // 3. mentioned, not allowlisted -> ignored
    await control("/__test/enqueue", {
      raw: rawGroupMessage({ userId: 999, text: "[USER=777]Test Bot[/USER] ping" }),
    });
    // 4. unlisted group           -> ignored
    const last = (await control("/__test/enqueue", {
      raw: rawGroupMessage({ userId: 42, text: "[USER=777]Test Bot[/USER] ping", dialogId: "chat6" }),
    })) as { eventId: number };

    await runPollerUntil({
      client,
      botId: "777",
      cfg: groupCfg(),
      accountId: "grp",
      stateStore,
      // All four events fetched and acknowledged (offset acks ids below it).
      predicate: () => fake.state.acks.some((offset) => offset > last.eventId),
    });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({ rawText: "[USER=777]Test Bot[/USER] ping" });
    expect(harness.calls[0]?.sessionKey).toContain(":group:chat5");
    expect(fake.state.sent).toEqual([
      expect.objectContaining({ dialogId: "chat5", message: "group pong", botId: "777" }),
    ]);
  });

  it("a join event makes no Bitrix call beyond Event.get and sends nothing", async () => {
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "grp-join", stateDir });
    harness.replyText = "should never be sent";
    await control("/__test/enqueue", {
      raw: {
        type: "ONIMBOTV2JOINCHAT",
        date: new Date().toISOString(),
        data: {
          bot: { id: 777 },
          dialogId: "chat5",
          chat: { id: 5, dialogId: "chat5", type: "chat", extranet: false, containsCollaber: false },
          user: { id: 42, name: "Fake User" },
          language: "en",
        },
      },
    });
    await runPollerUntil({
      client,
      botId: "777",
      cfg: groupCfg(),
      accountId: "grp-join",
      stateStore,
      predicate: () => fake.state.acks.length > 0,
    });
    expect(harness.calls).toHaveLength(0);
    expect(fake.state.sent).toHaveLength(0);
    expect(new Set(fake.state.calls.map((call) => call.method))).toEqual(new Set(["imbot.v2.Event.get"]));
  });

  it("real DM and group event shapes (synthetic values) are answered over HTTP", async () => {
    const { realShapeDmEvent, realShapeGroupEvent } = await import("./fixtures.js");
    // The fake portal assigns its own numeric eventId; drop the fixture's.
    const strip = (event: { eventId?: unknown }) => {
      const { eventId: _eventId, ...rest } = event;
      return rest;
    };
    const client = buildClient();
    const stateStore = createFileStateStore({ accountId: "grp-real", stateDir });
    harness.replyText = "real shape pong";
    await control("/__test/enqueue", { raw: strip(realShapeDmEvent({ userId: 42, botId: 777, text: "hello" })) });
    const last = (await control("/__test/enqueue", {
      raw: strip(realShapeGroupEvent({ userId: 42, botId: 777, dialogId: "chat5" })),
    })) as { eventId: number };

    await runPollerUntil({
      client,
      botId: "777",
      cfg: groupCfg(),
      accountId: "grp-real",
      stateStore,
      predicate: () => fake.state.acks.some((offset) => offset > last.eventId),
    });

    expect(harness.calls.map((call) => call.rawText)).toEqual([
      "hello",
      "[USER=777]Assistant[/USER] how many warehouses do we have?",
    ]);
    expect(harness.calls[1]?.sessionKey).toContain(":group:chat5");
    expect(fake.state.sent).toEqual([
      expect.objectContaining({ dialogId: "42", message: "real shape pong" }),
      expect.objectContaining({ dialogId: "chat5", message: "real shape pong" }),
    ]);
  });
});

describe("T-10 offset survives a restart", () => {
  it("persists the offset and does not replay after the poller is restarted", async () => {
    const client = buildClient();
    const accountId = "t10";
    harness.replyText = "ack";
    await control("/__test/enqueue", { userId: 42, text: "first" });

    const storeA = createFileStateStore({ accountId, stateDir });
    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId,
      stateStore: storeA,
      predicate: () => harness.calls.length > 0,
    });
    expect(harness.calls).toHaveLength(1);

    const persistedOffset = await storeA.get(BITRIX24_STATE_KEY_OFFSET);
    expect(persistedOffset).toBeTruthy();

    // The state file really is on disk and really is JSON.
    const onDisk: unknown = JSON.parse(await readFile(storeA.filePath, "utf8"));
    expect(onDisk).toMatchObject({ offset: persistedOffset });

    // Restart with a FRESH store instance reading the same file — no cache.
    harness.calls.length = 0;
    const storeB = createFileStateStore({ accountId, stateDir });
    expect(await storeB.get(BITRIX24_STATE_KEY_OFFSET)).toBe(persistedOffset);

    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId,
      stateStore: storeB,
      predicate: () => false,
      timeoutMs: 800,
    });

    // The stub never prunes acknowledged events, so a forgotten offset would
    // have redelivered "first" here.
    expect(harness.calls).toHaveLength(0);
    expect(fake.state.sent).toHaveLength(1);
  });

  it("replays when the offset is lost, proving the restart test is meaningful", async () => {
    const client = buildClient();
    harness.replyText = undefined;
    await control("/__test/enqueue", { userId: 42, text: "second" });

    const storeA = createFileStateStore({ accountId: "t10-a", stateDir });
    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t10-a",
      stateStore: storeA,
      predicate: () => harness.calls.length > 0,
    });
    expect(harness.calls).toHaveLength(1);

    harness.calls.length = 0;
    // A DIFFERENT account id ⇒ a different state file ⇒ no persisted offset.
    const storeB = createFileStateStore({ accountId: "t10-b", stateDir });
    await runPollerUntil({
      client,
      botId: "777",
      cfg: buildConfig(),
      accountId: "t10-b",
      stateStore: storeB,
      predicate: () => harness.calls.length > 0,
    });
    expect(harness.calls).toHaveLength(1);
  });
});
