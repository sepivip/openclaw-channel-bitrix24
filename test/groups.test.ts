// Group chats, hard guard, mentions, join events and sessions, driven through
// the real inbound path.
//
// What is real here: the plugin's inbound code, the SDK ingress resolver
// (`createChannelIngressResolver`: dmPolicy/groupPolicy/allowFrom/activation),
// the SDK router (`resolveAgentRoute`), the SDK context builder
// (`buildChannelInboundEventContext`, i.e. the exact ctx core would receive)
// and core's command authorization (`resolveCommandAuthorization`).
// What is mocked: only `runChannelInboundEvent`, the seam where a real Gateway
// takes over. The mock drives the adapter exactly like core (ingest, then
// resolveTurn) and records what the plugin handed over.

import { beforeEach, describe, expect, it, vi } from "vitest";
// `command-auth` is a deprecated SDK barrel; `command-auth-native`
// re-exports the same `resolveCommandAuthorization` since 2026.9.4.
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";

type CapturedTurn = {
  input: { rawText: string; textForAgent?: string; textForCommands?: string };
  plan: { ctxPayload: Record<string, unknown>; route: { agentId: string; sessionKey: string } };
};

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
      const input = (await params.adapter.ingest(params.raw)) as CapturedTurn["input"];
      const plan = (await params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      )) as CapturedTurn["plan"];
      harness.turns.push({ input, plan });
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

import {
  handleBitrix24InboundEvent,
  isIsolatedBitrix24GroupSession,
  resolveBitrix24Route,
} from "../src/inbound.js";
import { resetBitrix24ConfigNotices } from "../src/config-schema.js";
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
  dmEvent,
  groupEvent,
  joinEvent,
  mention,
  realShapeDmEvent,
  realShapeGroupEvent,
  realShapeJoinEvent,
} from "./fixtures.js";

const GROUP_SESSION = `agent:${AGENT_ID}:bitrix24:group:${LISTED_GROUP}`;

beforeEach(() => {
  harness.turns.length = 0;
  resetBitrix24ConfigNotices();
});

function onlyTurn(): CapturedTurn {
  expect(harness.turns).toHaveLength(1);
  return harness.turns[0] as CapturedTurn;
}

describe("group trigger: @mention AND allowlisted sender", () => {
  it("dispatches a mention from an allowlisted sender, with the mention stripped", async () => {
    const { deps, calls, log } = buildDeps(buildConfig());
    const raw = groupEvent({ text: mention("what is on today?") });

    const outcome = await handleBitrix24InboundEvent({ deps, raw });

    expect(outcome).toEqual({
      status: "dispatched",
      dispatched: true,
      agentId: AGENT_ID,
      sessionKey: GROUP_SESSION,
    });
    const { input, plan } = onlyTurn();
    expect(input.rawText).toBe(`[USER=${BOT_ID}]Test Bot[/USER] what is on today?`);
    expect(input.textForAgent).toBe("what is on today?");
    expect(input.textForCommands).toBe("what is on today?");
    const ctx = plan.ctxPayload;
    expect(ctx).toMatchObject({
      ChatType: "group",
      ChatId: LISTED_GROUP,
      To: LISTED_GROUP,
      SenderId: String(OWNER),
      BodyForAgent: "what is on today?",
      BodyForCommands: "what is on today?",
      WasMentioned: true,
      GroupRequireMention: true,
      SessionKey: GROUP_SESSION,
      AgentId: AGENT_ID,
    });
    expect(calls).toEqual([]); // nothing sent by the inbound path itself
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("inbound turn admitted kind=group"));
  });

  it("ignores a group message without a mention (core activation gate), silently", async () => {
    const { deps, calls, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ text: "hello everyone" }),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "not_mentioned", detail: "activation_skipped" });
    expect(harness.turns).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/ignored group message dialog=chat8801 sender=4101 reason=not_mentioned ingress=activation_skipped/),
    );
  });

  it("treats a mention of some OTHER user as no mention", async () => {
    const { deps } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ text: `[USER=${STAFF}]Synthetic User B[/USER] can you check?` }),
    });
    expect(outcome).toMatchObject({ status: "dropped", reason: "not_mentioned" });
    expect(harness.turns).toHaveLength(0);
  });

  it("ignores a mention from a sender who is not in allowFrom", async () => {
    const { deps, calls, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ userId: OUTSIDER, text: mention("let me in") }),
    });
    expect(outcome).toEqual({
      status: "dropped",
      reason: "blocked",
      detail: "group_policy_not_allowlisted",
    });
    expect(harness.turns).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("sender=4199 reason=blocked ingress=group_policy_not_allowlisted"),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("ignores every group sender when allowFrom is empty", async () => {
    const { deps } = buildDeps(buildConfig({ allowFrom: [] }));
    const outcome = await handleBitrix24InboundEvent({ deps, raw: groupEvent() });
    expect(outcome).toMatchObject({ status: "dropped", reason: "blocked", detail: "group_policy_empty_allowlist" });
  });

  it("honours requireMention:false for a listed group (sender gate still applies)", async () => {
    const cfg = buildConfig({ groups: { [LISTED_GROUP]: { requireMention: false } } });
    const { deps } = buildDeps(cfg);
    const outcome = await handleBitrix24InboundEvent({ deps, raw: groupEvent({ text: "no mention here" }) });
    expect(outcome).toMatchObject({ status: "dispatched" });
    expect(onlyTurn().plan.ctxPayload).toMatchObject({ WasMentioned: false, GroupRequireMention: false });

    harness.turns.length = 0;
    const blocked = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ userId: OUTSIDER, text: "no mention here" }),
    });
    expect(blocked).toMatchObject({ status: "dropped", reason: "blocked" });
    expect(harness.turns).toHaveLength(0);
  });
});

describe("group eligibility: groupPolicy and the groups map", () => {
  it("ignores a group that is not listed in `groups`", async () => {
    const { deps, calls, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ dialogId: UNLISTED_GROUP }),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "group_not_listed" });
    expect(harness.turns).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("reason=group_not_listed"));
  });

  it.each([
    ["disabled", { groupPolicy: "disabled" }],
    ["absent (default)", { groupPolicy: undefined }],
    ["an unsupported value such as 'open'", { groupPolicy: "open" }],
  ])("ignores every group when groupPolicy is %s, even a listed one", async (_label, section) => {
    const { deps, log } = buildDeps(buildConfig(section));
    const outcome = await handleBitrix24InboundEvent({ deps, raw: groupEvent() });
    expect(outcome).toEqual({ status: "dropped", reason: "group_disabled" });
    expect(harness.turns).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("reason=group_disabled groupPolicy=disabled"));
  });

  it("ignores a group whose dialog id is not chat<N>, even if the key were configured", async () => {
    const cfg = buildConfig({ groups: { [LISTED_GROUP]: {}, "8801": {} } });
    const { deps } = buildDeps(cfg);
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ dialogId: "chat8801x" }),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "group_not_listed" });
  });

  it("refuses a group when the bot id is unknown (mention could not be detected)", async () => {
    const { deps } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps: { ...deps, getBotId: () => "" },
      raw: groupEvent(),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "bot_id_unknown" });
  });
});

describe("HARD GUARD on group events: refused before config, ingress or reply", () => {
  it.each([
    ["an extranet chat", { chat: { extranet: true } }, "chat_extranet"],
    ["a chat with a collaber", { chat: { containsCollaber: true } }, "chat_contains_collaber"],
    ["an Open Lines chat", { chat: { entityType: "LINES" } }, "chat_entity_linked"],
    ["an open chat", { chat: { type: "open", messageType: "O" } }, "chat_type_not_allowed"],
    ["a channel", { chat: { type: "channel" } }, "chat_type_not_allowed"],
    ["a group with no extranet field", { chat: { extranet: undefined } }, "chat_extranet_unknown"],
    ["a group with no containsCollaber field", { chat: { containsCollaber: undefined } }, "chat_collaber_unknown"],
    ["a group with messageType O", { chat: { messageType: "O" } }, "chat_message_type_not_allowed"],
    ["a connector (external customer) sender", { user: { connector: true } }, "sender_connector"],
    ["an extranet sender", { user: { extranet: true } }, "sender_extranet"],
    ["an email-auth sender", { user: { externalAuthId: "email" } }, "sender_external_auth"],
    ["a user.id / authorId mismatch", { authorId: STAFF }, "sender_author_mismatch"],
  ])("ignores %s", async (_label, overrides, reason) => {
    const { deps, calls, log, getAccount, getConfig } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ text: mention("hello"), ...(overrides as Parameters<typeof groupEvent>[0]) }),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "guard_refused", detail: reason });
    expect(getAccount).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
    expect(harness.turns).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`(hard guard) kind=group`));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(`reason=${reason}`));
    // The log line never carries message content.
    expect(log.all().join("\n")).not.toContain("hello");
  });
});

describe("HARD GUARD on DMs: normal users unchanged, risky senders refused", () => {
  it("still dispatches a normal DM from an allowlisted user, text verbatim", async () => {
    const { deps } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: dmEvent({ text: mention("hi") }),
    });
    expect(outcome).toMatchObject({
      status: "dispatched",
      sessionKey: `agent:${AGENT_ID}:bitrix24:direct:${OWNER}`,
    });
    const ctx = onlyTurn().plan.ctxPayload;
    expect(ctx).toMatchObject({ ChatType: "direct", SenderId: String(OWNER), To: String(OWNER) });
    // DMs are not mention-stripped and carry no mention facts.
    expect(ctx.BodyForAgent).toBe(`[USER=${BOT_ID}]Test Bot[/USER] hi`);
    expect(ctx.WasMentioned).toBeUndefined();
  });

  it("is unaffected by groupPolicy", async () => {
    const { deps } = buildDeps(buildConfig({ groupPolicy: "disabled", groups: {} }));
    const outcome = await handleBitrix24InboundEvent({ deps, raw: dmEvent() });
    expect(outcome).toMatchObject({ status: "dispatched" });
  });

  it("still blocks a DM from a sender outside allowFrom (warn, as before)", async () => {
    const { deps, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({ deps, raw: dmEvent({ userId: OUTSIDER }) });
    expect(outcome).toEqual({ status: "dropped", reason: "blocked" });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Blocked unauthorized bitrix24 sender 4199"));
  });

  it.each([
    ["an extranet sender", { user: { extranet: true } }, "sender_extranet"],
    ["a connector sender", { user: { connector: true } }, "sender_connector"],
    ["an external-auth sender", { user: { externalAuthId: "replica" } }, "sender_external_auth"],
    ["an Open Lines DM", { chat: { entityType: "LINES" } }, "chat_entity_linked"],
  ])("refuses %s even when the sender is allowlisted", async (_label, overrides, reason) => {
    const { deps, getAccount, calls } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: dmEvent(overrides as Parameters<typeof dmEvent>[0]),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "guard_refused", detail: reason });
    expect(getAccount).not.toHaveBeenCalled();
    expect(harness.turns).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});

describe("externalAuthId is a denylist (regression: real staff carry 'socservices')", () => {
  const events = {
    DM: (externalAuthId: string) => dmEvent({ user: { externalAuthId } }),
    group: (externalAuthId: string) => groupEvent({ user: { externalAuthId } }),
  };

  describe.each(["DM", "group"] as const)("in a %s", (kind) => {
    it.each(["socservices", "default"])("an allowlisted sender with %s is dispatched", async (value) => {
      const { deps } = buildDeps(buildConfig());
      const outcome = await handleBitrix24InboundEvent({ deps, raw: events[kind](value) });
      expect(outcome).toMatchObject({ status: "dispatched", dispatched: true });
      expect(onlyTurn().plan.ctxPayload.SenderId).toBe(String(OWNER));
    });

    it.each(["email", "replica", "bot", "imconnector"])(
      "a sender with %s is refused before config and ingress",
      async (value) => {
        const { deps, getAccount, calls } = buildDeps(buildConfig());
        const outcome = await handleBitrix24InboundEvent({ deps, raw: events[kind](value) });
        expect(outcome).toEqual({ status: "dropped", reason: "guard_refused", detail: "sender_external_auth" });
        expect(getAccount).not.toHaveBeenCalled();
        expect(harness.turns).toHaveLength(0);
        expect(calls).toEqual([]);
      },
    );

    it("a socservices sender NOT on allowFrom is still blocked by core ingress", async () => {
      const { deps } = buildDeps(buildConfig());
      const raw =
        kind === "DM"
          ? dmEvent({ userId: OUTSIDER, user: { externalAuthId: "socservices" } })
          : groupEvent({ userId: OUTSIDER, user: { externalAuthId: "socservices" } });
      const outcome = await handleBitrix24InboundEvent({ deps, raw });
      expect(outcome).toMatchObject({ status: "dropped", reason: "blocked" });
      expect(harness.turns).toHaveLength(0);
    });
  });
});

describe("commands in groups stay owner-only (core decides; the plugin hands the facts)", () => {
  it("does not dispatch a command from a non-allowlisted group sender", async () => {
    const { deps, calls } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: groupEvent({ userId: OUTSIDER, text: mention("/status") }),
    });
    expect(outcome).toMatchObject({ status: "dropped", reason: "blocked" });
    expect(harness.turns).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("hands core the real author and the stripped command text", async () => {
    const cfg = buildConfig();
    const { deps } = buildDeps(cfg);
    await handleBitrix24InboundEvent({ deps, raw: groupEvent({ userId: OWNER, text: mention("/status") }) });
    const { input, plan } = onlyTurn();
    expect(input.textForCommands).toBe("/status");
    const ctx = plan.ctxPayload;
    expect(ctx).toMatchObject({
      SenderId: String(OWNER),
      BodyForCommands: "/status",
      CommandBody: "/status",
      ChatType: "group",
      Provider: "bitrix24",
    });
    expect((ctx.CommandTurn as { commandName?: string }).commandName).toBe("status");

    // Core's own command authorization over the ctx the plugin built:
    // commands.allowFrom.bitrix24 = [OWNER].
    const owner = resolveCommandAuthorization({
      ctx: ctx as never,
      cfg,
      commandAuthorized: ctx.CommandAuthorized === true,
    });
    expect(owner).toMatchObject({ isAuthorizedSender: true, senderId: String(OWNER) });
  });

  it("an allowlisted non-owner's command reaches core, and core refuses it", async () => {
    const cfg = buildConfig();
    const { deps } = buildDeps(cfg);
    await handleBitrix24InboundEvent({ deps, raw: groupEvent({ userId: STAFF, text: mention("/status") }) });
    const ctx = onlyTurn().plan.ctxPayload;
    expect(ctx).toMatchObject({ SenderId: String(STAFF), BodyForCommands: "/status" });
    const staff = resolveCommandAuthorization({
      ctx: ctx as never,
      cfg,
      commandAuthorized: ctx.CommandAuthorized === true,
    });
    expect(staff).toMatchObject({ isAuthorizedSender: false, senderId: String(STAFF) });
  });

  it("never hands core the group dialog id or the bot as the sender", async () => {
    const { deps } = buildDeps(buildConfig());
    await handleBitrix24InboundEvent({ deps, raw: groupEvent({ userId: STAFF, text: mention("/new") }) });
    const ctx = onlyTurn().plan.ctxPayload;
    expect(ctx.SenderId).toBe(String(STAFF));
    expect(ctx.SenderId).not.toBe(LISTED_GROUP);
    expect(ctx.SenderId).not.toBe(BOT_ID);
    expect(ctx.CommandAuthorized).toBe(false); // the plugin grants nothing itself
  });
});

describe("sessions: one per group chat, separate from DMs", () => {
  const dmScopes = ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"] as const;

  it.each(dmScopes)("group key differs from every DM key (dmScope=%s)", (dmScope) => {
    const cfg = buildConfig({}, { session: { dmScope } });
    const groupRoute = resolveBitrix24Route({
      cfg,
      accountId: "default",
      chatKind: "group",
      conversationId: LISTED_GROUP,
      senderStableId: String(OWNER),
    });
    expect(groupRoute.sessionKey).toBe(GROUP_SESSION);
    expect(groupRoute.sessionKey).toContain(LISTED_GROUP);
    expect(isIsolatedBitrix24GroupSession(groupRoute, LISTED_GROUP)).toBe(true);
    for (const sender of [OWNER, STAFF, OUTSIDER]) {
      const dmRoute = resolveBitrix24Route({
        cfg,
        accountId: "default",
        chatKind: "direct",
        conversationId: String(sender),
        senderStableId: String(sender),
      });
      expect(dmRoute.sessionKey).not.toBe(groupRoute.sessionKey);
    }
    expect(groupRoute.sessionKey).not.toBe(groupRoute.mainSessionKey);
  });

  it("two groups get two sessions", () => {
    const cfg = buildConfig();
    const keys = [LISTED_GROUP, UNLISTED_GROUP].map(
      (conversationId) =>
        resolveBitrix24Route({
          cfg,
          accountId: "default",
          chatKind: "group",
          conversationId,
          senderStableId: String(OWNER),
        }).sessionKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("the same sender gets different sessions in a DM and in a group", async () => {
    const { deps } = buildDeps(buildConfig());
    const dm = await handleBitrix24InboundEvent({ deps, raw: dmEvent({ userId: OWNER }) });
    const grp = await handleBitrix24InboundEvent({ deps, raw: groupEvent({ userId: OWNER }) });
    expect(dm).toMatchObject({ status: "dispatched" });
    expect(grp).toMatchObject({ status: "dispatched", sessionKey: GROUP_SESSION });
    expect((dm as { sessionKey: string }).sessionKey).not.toBe((grp as { sessionKey: string }).sessionKey);
  });

  it("refuses a group when session.groupScope folds groups into the main session", async () => {
    const cfg = buildConfig({}, { session: { dmScope: "main", groupScope: "main" } });
    const { deps, log } = buildDeps(cfg);
    const outcome = await handleBitrix24InboundEvent({ deps, raw: groupEvent() });
    expect(outcome).toEqual({ status: "dropped", reason: "group_session_not_isolated" });
    expect(harness.turns).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("not a per-group session"));
  });
});

describe("ONIMBOTV2JOINCHAT", () => {
  it("logs one info line with dialog, adder, chat type, guard and listing; no reply", async () => {
    const { deps, calls, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({ deps, raw: joinEvent({ addedBy: STAFF }) });
    expect(outcome).toEqual({ status: "dropped", reason: "join_chat" });
    expect(calls).toEqual([]);
    expect(harness.turns).toHaveLength(0);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[bitrix24] bot added to chat dialog=chat8801 addedBy=4102 chatType=chat kind=group " +
        "guard=pass listed=true groupPolicy=allowlist (no reply sent)",
    );
  });

  it("reports an unlisted chat that fails the guard", async () => {
    const { deps, calls, log } = buildDeps(buildConfig());
    await handleBitrix24InboundEvent({
      deps,
      raw: joinEvent({ dialogId: UNLISTED_GROUP, chat: { extranet: true } }),
    });
    expect(calls).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("dialog=chat8802 addedBy=4101 chatType=chat kind=group guard=refuse:chat_extranet listed=false"),
    );
  });

  it("still logs (listed=unknown) when the account can not be resolved", async () => {
    const { deps, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps: {
        ...deps,
        getAccount: () => {
          throw new Error("config unavailable");
        },
      },
      raw: joinEvent(),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "join_chat" });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("listed=unknown groupPolicy=unknown"));
  });

  it("masks a malformed dialog id in the log line", async () => {
    const { deps, log } = buildDeps(buildConfig());
    await handleBitrix24InboundEvent({ deps, raw: joinEvent({ dialogId: "chat1\nFAKE LOG LINE" }) });
    const line = String(log.info.mock.calls[0]?.[0]);
    expect(line).toContain("dialog=<invalid>");
    expect(line).not.toContain("\n");
  });

  describe("real shape: the bot created the chat, so the bot is data.user", () => {
    it("is logged as addedBy=self, not refused, no reply, no crash", async () => {
      const raw = realShapeJoinEvent();
      expect(Object.keys(raw.data ?? {}).sort()).toEqual(["bot", "chat", "dialogId", "language", "user"]);
      const { deps, calls, log } = buildDeps(buildConfig());
      const outcome = await handleBitrix24InboundEvent({ deps, raw });
      expect(outcome).toEqual({ status: "dropped", reason: "join_chat" });
      expect(calls).toEqual([]);
      expect(harness.turns).toHaveLength(0);
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        "[bitrix24] bot added to chat dialog=chat8801 addedBy=self chatType=chat kind=group " +
          "guard=pass listed=true groupPolicy=allowlist (no reply sent)",
      );
      // Not treated as the loop guard or the sender guard (bot: true,
      // externalAuthId: "bot" would refuse a MESSAGE, never a join).
      expect(log.debug).not.toHaveBeenCalled();
      expect(log.all().join("\n")).not.toContain("hard guard");
    });

    it("still reports self when the live bot id can not be read (uses data.bot.id)", async () => {
      const { deps, log } = buildDeps(buildConfig());
      const outcome = await handleBitrix24InboundEvent({
        deps: {
          ...deps,
          getBotId: () => {
            throw new Error("bot id unavailable");
          },
        },
        raw: realShapeJoinEvent({ dialogId: UNLISTED_GROUP }),
      });
      expect(outcome).toEqual({ status: "dropped", reason: "join_chat" });
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("dialog=chat8802 addedBy=self"));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("listed=false"));
    });

    it("labels a DIFFERENT bot as bot:<id>", async () => {
      const raw = realShapeJoinEvent();
      raw.data!.user = { ...raw.data!.user, id: 9002 };
      const { deps, log } = buildDeps(buildConfig());
      await handleBitrix24InboundEvent({ deps, raw });
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("addedBy=bot:9002 "));
    });
  });
});

describe("real event shapes (synthetic values), end to end: guard -> mention -> ingress", () => {
  const REAL_DATA_KEYS = ["additionalMessages", "bot", "chat", "language", "message", "user"];

  it("the fixtures carry the captured key sets and field types", () => {
    const dm = realShapeDmEvent();
    const grp = realShapeGroupEvent();
    for (const raw of [dm, grp]) {
      expect(Object.keys(raw.data ?? {}).sort()).toEqual(REAL_DATA_KEYS);
      const message = raw.data?.message as Record<string, unknown>;
      expect(Object.keys(message).sort()).toEqual(
        [
          "author_id",
          "authorId",
          "block",
          "chatId",
          "chat_id",
          "forward",
          "id",
          "isSystem",
          "params",
          "text",
          "uuid",
          "viewedByOthers",
        ].sort(),
      );
      expect(message.params).toEqual([]);
      expect(message.chat_id).toBe(message.chatId);
      expect(message.author_id).toBe(message.authorId);
      expect(raw.data?.user).toEqual({
        id: OWNER,
        extranet: false,
        bot: false,
        connector: false,
        externalAuthId: "socservices",
        active: true,
      });
      expect(raw.data?.chat?.entityType).toBe("");
      expect(raw.data?.chat?.owner).toBe(Number(BOT_ID));
    }
    expect(dm.data?.chat).toMatchObject({ dialogId: String(OWNER), type: "private", messageType: "P", entityId: "" });
    expect(grp.data?.chat).toMatchObject({ dialogId: LISTED_GROUP, type: "chat", messageType: "C" });
    expect(grp.data?.message?.text).toBe(`[USER=${BOT_ID}]Assistant[/USER] how many warehouses do we have?`);
  });

  it("DM (shape 1) from an allowlisted 'socservices' employee is dispatched", async () => {
    const { deps, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({ deps, raw: realShapeDmEvent({ text: "hello" }) });
    expect(outcome).toMatchObject({
      status: "dispatched",
      dispatched: true,
      sessionKey: `agent:${AGENT_ID}:bitrix24:direct:${OWNER}`,
    });
    const { input, plan } = onlyTurn();
    expect(input).toMatchObject({ rawText: "hello", textForAgent: "hello", textForCommands: "hello" });
    expect(plan.ctxPayload).toMatchObject({
      ChatType: "direct",
      SenderId: String(OWNER),
      To: String(OWNER),
      BodyForAgent: "hello",
      BodyForCommands: "hello",
    });
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("hard guard"));
  });

  it("group mention (shape 2) from an allowlisted 'socservices' employee is dispatched, mention stripped", async () => {
    const { deps, log } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({ deps, raw: realShapeGroupEvent() });
    expect(outcome).toMatchObject({ status: "dispatched", dispatched: true, sessionKey: GROUP_SESSION });
    const { input, plan } = onlyTurn();
    expect(input).toMatchObject({
      rawText: `[USER=${BOT_ID}]Assistant[/USER] how many warehouses do we have?`,
      textForAgent: "how many warehouses do we have?",
      textForCommands: "how many warehouses do we have?",
    });
    expect(plan.ctxPayload).toMatchObject({
      ChatType: "group",
      ChatId: LISTED_GROUP,
      To: LISTED_GROUP,
      SenderId: String(OWNER),
      BodyForAgent: "how many warehouses do we have?",
      BodyForCommands: "how many warehouses do we have?",
      WasMentioned: true,
      GroupRequireMention: true,
    });
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("hard guard"));
  });

  it("group command (shape 2) reaches core as the bare command with the real author", async () => {
    const { deps } = buildDeps(buildConfig());
    await handleBitrix24InboundEvent({
      deps,
      raw: realShapeGroupEvent({ userId: STAFF, text: `[USER=${BOT_ID}]Assistant[/USER] /status` }),
    });
    expect(onlyTurn().plan.ctxPayload).toMatchObject({ SenderId: String(STAFF), BodyForCommands: "/status" });
  });

  it("the same shapes from a sender NOT on allowFrom are blocked", async () => {
    const { deps } = buildDeps(buildConfig());
    expect(await handleBitrix24InboundEvent({ deps, raw: realShapeDmEvent({ userId: OUTSIDER }) })).toMatchObject({
      status: "dropped",
      reason: "blocked",
    });
    expect(await handleBitrix24InboundEvent({ deps, raw: realShapeGroupEvent({ userId: OUTSIDER }) })).toMatchObject({
      status: "dropped",
      reason: "blocked",
    });
    expect(harness.turns).toHaveLength(0);
  });

  it("a group shape without the mention (Bitrix does not send these live) is still skipped by core", async () => {
    const { deps } = buildDeps(buildConfig());
    const outcome = await handleBitrix24InboundEvent({
      deps,
      raw: realShapeGroupEvent({ text: "how many warehouses do we have?" }),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "not_mentioned", detail: "activation_skipped" });
    expect(harness.turns).toHaveLength(0);
  });
});
