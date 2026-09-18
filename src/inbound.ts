// Inbound: envelope parsing, loop guard, SDK ingress, and the
// `runChannelInboundEvent` adapter that starts an agent turn.
//
// Ordering is load-bearing (design §2.2):
//   1. event type filter        — only ONIMBOTV2MESSAGEADD can start a turn
//   2. loop guard               — the bot's own echo never reaches policy
//   3. group drop               — groupPolicy: "disabled" ⇒ DMs only
//   4. SDK ingress              — core owns dmPolicy / allowFrom / pairing
//   5. runChannelInboundEvent   — core owns classify → resolve → record → dispatch
//
// There is no hand-rolled allow decision anywhere in this file: step 4 delegates
// to `createChannelIngressResolver`, the same core evaluator the bundled
// Telegram channel uses (`/app/extensions/telegram/src/ingress.ts`).

import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { Bitrix24Client } from "./client.js";
import {
  BITRIX24_CHANNEL_ID,
  type Bitrix24DmPolicy,
  type ResolvedBitrix24Account,
} from "./config-schema.js";
import { Bitrix24Error } from "./secrets.js";
import { sendText as sendBitrix24Text, sendTyping as sendBitrix24Typing } from "./outbound.js";

/** The only event that may start an agent turn in the MVP. */
export const BITRIX24_MESSAGE_EVENT = "ONIMBOTV2MESSAGEADD";

/**
 * `imbot.v2.Event.get` envelope, narrowed to what we read.
 *
 * Verified against apidocs `imbot.v2.Event.get` (envelope: `eventId`, `type`,
 * `date`, `data`) and `ONIMBOTV2MESSAGEADD` (`data.{bot,message,chat,user}`).
 * `event`/`ts` are accepted as tolerant aliases so an older portal build cannot
 * silently drop every message.
 */
export type Bitrix24RawEvent = {
  eventId?: string | number;
  /** Event name, e.g. `ONIMBOTV2MESSAGEADD`. */
  type?: string;
  /** Tolerated alias for `type`. */
  event?: string;
  /** ISO-8601 per apidocs. */
  date?: string;
  /** Tolerated alias carrying epoch millis. */
  ts?: number;
  data?: {
    bot?: { id?: string | number; code?: string };
    message?: {
      id?: string | number;
      chatId?: string | number;
      authorId?: string | number;
      text?: string;
      isSystem?: boolean;
    };
    chat?: { id?: string | number; dialogId?: string | number; type?: string; name?: string };
    user?: { id?: string | number; name?: string; bot?: boolean; isBot?: boolean };
  };
};

export type Bitrix24ChatKind = "direct" | "group";

export type NormalizedBitrix24Event = {
  /** `eventId` → turn id / idempotency key. */
  id: string;
  timestampMs: number | undefined;
  /** `data.message.text` → rawText / textForAgent. */
  text: string;
  /** `data.chat.dialogId` → conversation id (`{userId}` for DMs, `chat{id}` for groups). */
  conversationId: string;
  /** `String(data.user.id)` → sender stable id, matched against `allowFrom`. */
  senderStableId: string;
  senderName: string | undefined;
  senderIsBot: boolean;
  authorId: string;
  /** `data.chat.type` verbatim, for diagnostics. */
  chatType: string | undefined;
  chatKind: Bitrix24ChatKind;
  chatLabel: string | undefined;
  messageId: string | undefined;
};

function asId(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

/** Event name, tolerating the `event` alias. */
export function bitrix24EventName(raw: Bitrix24RawEvent): string {
  return (typeof raw.type === "string" ? raw.type : (raw.event ?? "")).trim().toUpperCase();
}

/**
 * Classify the conversation.
 *
 * `Chat.Message.send` documents `dialogId` as "for group chats — `chat{chatId}`,
 * for personal chats — `{userId}`", so a purely numeric dialogId is a DM. The
 * `chat.type` string is used first when it is one of the known values.
 */
export function resolveBitrix24ChatKind(chat: Bitrix24RawEvent["data"] extends infer _ ? NonNullable<Bitrix24RawEvent["data"]>["chat"] : never): Bitrix24ChatKind {
  const type = typeof chat?.type === "string" ? chat.type.trim().toLowerCase() : "";
  if (type === "private" || type === "user" || type === "dialog") {
    return "direct";
  }
  if (type) {
    // "chat", "group", "lines", "call", "sonet_group", … are all non-direct.
    return "group";
  }
  const dialogId = asId(chat?.dialogId);
  return /^\d+$/.test(dialogId) ? "direct" : "group";
}

/**
 * LOOP GUARD. Drop the bot's own messages and anything flagged as a bot before
 * ingress, so a reply can never re-enter the agent.
 *
 * `data.user.bot` is the documented field name (`ONIMBOTV2MESSAGEADD` sample:
 * `"bot": false` inside `user`); `isBot` is accepted as a tolerant alias.
 */
export function isOwnBitrix24Event(raw: Bitrix24RawEvent, botId: string | number): boolean {
  const authorId = asId(raw.data?.message?.authorId);
  const self = asId(botId);
  if (self && authorId && authorId === self) {
    return true;
  }
  const eventBotId = asId(raw.data?.bot?.id);
  if (self && eventBotId && eventBotId === self && authorId && authorId === eventBotId) {
    return true;
  }
  return raw.data?.user?.bot === true || raw.data?.user?.isBot === true;
}

function parseTimestampMs(raw: Bitrix24RawEvent): number | undefined {
  if (typeof raw.ts === "number" && Number.isFinite(raw.ts)) {
    return raw.ts;
  }
  if (typeof raw.date === "string" && raw.date.length > 0) {
    const parsed = Date.parse(raw.date);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const messageDate = (raw.data?.message as { date?: unknown } | undefined)?.date;
  if (typeof messageDate === "string") {
    const parsed = Date.parse(messageDate);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Project a Bitrix event onto the fields core needs. Pure; no I/O. */
export function normalizeBitrix24Event(raw: Bitrix24RawEvent): NormalizedBitrix24Event | null {
  const conversationId = asId(raw.data?.chat?.dialogId) || asId(raw.data?.chat?.id);
  const senderStableId = asId(raw.data?.user?.id) || asId(raw.data?.message?.authorId);
  if (!conversationId || !senderStableId) {
    return null;
  }
  const messageId = asId(raw.data?.message?.id) || undefined;
  const id = asId(raw.eventId) || (messageId ? `${conversationId}:${messageId}` : conversationId);
  return {
    id,
    timestampMs: parseTimestampMs(raw),
    text: typeof raw.data?.message?.text === "string" ? raw.data.message.text : "",
    conversationId,
    senderStableId,
    senderName:
      typeof raw.data?.user?.name === "string" && raw.data.user.name
        ? raw.data.user.name
        : undefined,
    senderIsBot: raw.data?.user?.bot === true || raw.data?.user?.isBot === true,
    authorId: asId(raw.data?.message?.authorId),
    chatType: typeof raw.data?.chat?.type === "string" ? raw.data.chat.type : undefined,
    chatKind: resolveBitrix24ChatKind(raw.data?.chat),
    chatLabel: typeof raw.data?.chat?.name === "string" ? raw.data.chat.name : undefined,
    messageId,
  };
}

/**
 * Ingress identity for this channel: a single stable numeric Bitrix user id.
 * The same normalizer runs over configured `allowFrom` entries and over the
 * inbound sender, so `42` and `"42"` compare equal and nothing else matches.
 */
const bitrix24IngressIdentity = defineStableChannelIngressIdentity({
  key: "bitrix24-user-id",
  normalize: (value) => {
    const text = String(value ?? "").trim();
    if (text === "*") {
      return "*";
    }
    return /^\d+$/.test(text) ? text : null;
  },
  isWildcardEntry: (value) => value.trim() === "*",
  sensitivity: "pii",
});

export type Bitrix24Log = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

function logAt(log: Bitrix24Log | undefined, level: keyof Bitrix24Log, text: string): void {
  const sink = log?.[level] ?? log?.info;
  if (typeof sink === "function") {
    sink(text);
    return;
  }
  console.log(text);
}

export type Bitrix24InboundDeps = {
  /** Live config snapshot. Re-read per batch so a hot reload is picked up. */
  getConfig: () => OpenClawConfig;
  /** Live account projection (dmPolicy, allowFrom, groupPolicy, bot identity). */
  getAccount: () => ResolvedBitrix24Account;
  accountId: string;
  client: Bitrix24Client;
  /** Numeric bot id from `imbot.v2.Bot.register`. */
  getBotId: () => string;
  botToken: string;
  /**
   * `dispatchReplyFromConfig` injected by the Gateway
   * (`PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]`). Without it
   * core falls back to its own resolver.
   */
  dispatchReplyFromConfig?: unknown;
  log?: Bitrix24Log;
  abortSignal?: AbortSignal;
};

export type Bitrix24InboundOutcome =
  | {
      status: "dropped";
      reason: "not_a_message" | "loop_guard" | "unmappable" | "group_disabled" | "blocked" | "pairing";
    }
  | { status: "dispatched"; dispatched: boolean; agentId: string; sessionKey: string };

/** Build the turn plan handed back to core from `adapter.resolveTurn`. */
async function buildTurnPlan(params: {
  deps: Bitrix24InboundDeps;
  cfg: OpenClawConfig;
  normalized: NormalizedBitrix24Event;
  ingress: unknown;
}): Promise<ChannelInboundTurnPlan<"provider_message_sending">> {
  const { deps, cfg, normalized } = params;
  const accountId = deps.accountId;
  const peerKind = normalized.chatKind;
  const peerId = peerKind === "direct" ? normalized.senderStableId : normalized.conversationId;

  // bindings[] decide the agent. `matchedBy` records which rule won.
  const route = resolveAgentRoute({
    cfg,
    channel: BITRIX24_CHANNEL_ID,
    accountId,
    peer: { kind: peerKind, id: peerId },
  });
  const sessionKey =
    route.sessionKey ||
    buildAgentSessionKey({
      agentId: route.agentId,
      ...(cfg.session?.mainKey ? { mainKey: cfg.session.mainKey } : {}),
      channel: BITRIX24_CHANNEL_ID,
      accountId,
      peer: { kind: peerKind, id: peerId },
      ...(route.dmScope ? { dmScope: route.dmScope } : {}),
      ...(cfg.session?.identityLinks ? { identityLinks: cfg.session.identityLinks } : {}),
    });

  const dialogId = normalized.conversationId;
  const botId = deps.getBotId();

  const ctxPayload = buildChannelInboundEventContext({
    channel: BITRIX24_CHANNEL_ID,
    accountId,
    ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
    ...(normalized.timestampMs === undefined ? {} : { timestamp: normalized.timestampMs }),
    from: `${BITRIX24_CHANNEL_ID}:${dialogId}`,
    sender: {
      id: normalized.senderStableId,
      ...(normalized.senderName ? { name: normalized.senderName } : {}),
      isBot: normalized.senderIsBot,
    },
    conversation: {
      kind: peerKind,
      id: dialogId,
      ...(normalized.chatLabel ? { label: normalized.chatLabel } : {}),
      routePeer: { kind: peerKind, id: peerId },
    },
    route: {
      agentId: route.agentId,
      ...(route.dmScope ? { dmScope: route.dmScope } : {}),
      accountId: route.accountId,
      routeSessionKey: sessionKey,
      mainSessionKey: route.mainSessionKey,
    },
    reply: { to: dialogId },
    message: {
      // InboundEventKind is "user_request" | "room_event"; a DM is a request.
      inboundEventKind: "user_request",
      rawBody: normalized.text,
      body: normalized.text,
      bodyForAgent: normalized.text,
    },
    // The exact host-resolved ingress result; core re-validates it at dispatch.
    channelIngress: params.ingress as never,
  });

  const replyPipeline = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: BITRIX24_CHANNEL_ID,
    accountId,
    typing: {
      start: async () => {
        // Typing is best effort: an unverified v2 param shape must never fail a turn.
        try {
          await sendBitrix24Typing({
            client: deps.client,
            botId,
            botToken: deps.botToken,
            dialogId,
            ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
          });
        } catch (error) {
          logAt(
            deps.log,
            "debug",
            `[bitrix24] typing indicator failed (non-fatal) ${describeError(error)}`,
          );
        }
      },
      onStartError: (error: unknown) => {
        logAt(
          deps.log,
          "debug",
          `[bitrix24] typing indicator failed (non-fatal) ${describeError(error)}`,
        );
      },
      keepaliveIntervalMs: 20_000,
      maxDurationMs: 0,
      maxConsecutiveFailures: 3,
    },
  });

  return {
    cfg,
    channel: BITRIX24_CHANNEL_ID,
    accountId,
    route: { agentId: route.agentId, sessionKey },
    ctxPayload,
    record: { createIfMissing: true },
    ...(deps.dispatchReplyFromConfig
      ? { dispatchReplyFromConfig: deps.dispatchReplyFromConfig as never }
      : {}),
    delivery: {
      deliverWithProviderMessageSending: async (payload, info) => {
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!text.trim()) {
          return { visibleReplySent: false };
        }
        info.assertPlatformSendAuthorized();
        await info.onPlatformSendDispatch();
        const messageIds = await sendBitrix24Text({
          client: deps.client,
          botId,
          botToken: deps.botToken,
          dialogId,
          text,
          ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
        });
        return { messageIds, visibleReplySent: messageIds.length > 0, content: text };
      },
      onError: (error: unknown, info: { kind: string }) => {
        logAt(
          deps.log,
          "warn",
          `[bitrix24] reply delivery failed (${info.kind}) ${describeError(error)}`,
        );
      },
    },
    dispatcherOptions: { ...replyPipeline },
  } as ChannelInboundTurnPlan<"provider_message_sending">;
}

/** Credential-free error projection. Never hand a raw error to a log sink. */
export function describeError(error: unknown): string {
  if (error instanceof Bitrix24Error) {
    return JSON.stringify(error.toLogFields());
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  return JSON.stringify({ code: name, description: message.slice(0, 200) });
}

/**
 * Run one Bitrix event through loop guard → SDK ingress → the inbound kernel.
 *
 * Never throws for a single bad event: the poller must keep draining.
 */
export async function handleBitrix24InboundEvent(params: {
  deps: Bitrix24InboundDeps;
  raw: Bitrix24RawEvent;
}): Promise<Bitrix24InboundOutcome> {
  const { deps, raw } = params;
  const log = deps.log;

  // 0. Only message-add events can start a turn. Everything else (join chat,
  //    reaction, delete, …) is acknowledged by the offset and ignored.
  const eventName = bitrix24EventName(raw);
  if (eventName !== BITRIX24_MESSAGE_EVENT) {
    logAt(log, "debug", `[bitrix24] ignoring event ${eventName || "<unnamed>"}`);
    return { status: "dropped", reason: "not_a_message" };
  }

  // 1. Loop guard, BEFORE ingress and before any policy evaluation.
  const botId = deps.getBotId();
  if (isOwnBitrix24Event(raw, botId)) {
    logAt(log, "debug", "[bitrix24] dropped own/bot message (loop guard)");
    return { status: "dropped", reason: "loop_guard" };
  }

  const normalized = normalizeBitrix24Event(raw);
  if (!normalized) {
    logAt(log, "debug", "[bitrix24] dropped event without a dialogId or user id");
    return { status: "dropped", reason: "unmappable" };
  }

  const account = deps.getAccount();
  const cfg = deps.getConfig();

  // 2. Groups are out of MVP scope: drop non-direct chats before ingress.
  if (normalized.chatKind !== "direct" && account.groupPolicy === "disabled") {
    logAt(
      log,
      "debug",
      `[bitrix24] dropped non-direct chat ${normalized.conversationId} ` +
        `(type=${normalized.chatType ?? "unknown"}, groupPolicy=disabled)`,
    );
    return { status: "dropped", reason: "group_disabled" };
  }

  // 3. Core-owned ingress: dmPolicy, allowFrom, pairing store, access groups.
  //    The plugin supplies facts; it does not decide.
  const dmPolicy: Bitrix24DmPolicy = account.dmPolicy;
  const resolver = createChannelIngressResolver({
    channelId: BITRIX24_CHANNEL_ID,
    accountId: deps.accountId,
    identity: bitrix24IngressIdentity,
    cfg,
    useDefaultPairingStore: true,
  });
  const resolved = await resolver.message({
    subject: { stableId: normalized.senderStableId },
    conversation: { kind: normalized.chatKind, id: normalized.conversationId },
    dmPolicy,
    groupPolicy: "disabled",
    allowFrom: account.allowFrom,
    groupAllowFrom: [],
  });

  if (resolved.ingress.decision === "pairing") {
    await issuePairingChallenge({ deps, normalized }).catch((error: unknown) => {
      logAt(log, "warn", `[bitrix24] pairing challenge failed ${describeError(error)}`);
    });
    return { status: "dropped", reason: "pairing" };
  }
  if (resolved.ingress.decision !== "allow") {
    logAt(
      log,
      "warn",
      `[bitrix24] Blocked unauthorized bitrix24 sender ${normalized.senderStableId} ` +
        `(dmPolicy=${dmPolicy}, reason=${resolved.ingress.reasonCode})`,
    );
    return { status: "dropped", reason: "blocked" };
  }

  // 4. Core owns ingest → classify → preflight → resolve → record → dispatch.
  const result = await runChannelInboundEvent<NormalizedBitrix24Event>({
    channel: BITRIX24_CHANNEL_ID,
    accountId: deps.accountId,
    raw: normalized,
    adapter: {
      ingest: (input: NormalizedBitrix24Event) => ({
        id: input.id,
        ...(input.timestampMs === undefined ? {} : { timestamp: input.timestampMs }),
        rawText: input.text,
        textForAgent: input.text,
        textForCommands: input.text,
        raw: input,
      }),
      resolveTurn: async () =>
        await buildTurnPlan({ deps, cfg, normalized, ingress: resolved }),
    },
  } as Parameters<typeof runChannelInboundEvent<NormalizedBitrix24Event>>[0]);

  const dispatched = result.dispatched === true;
  const sessionKey = result.dispatched === true ? result.routeSessionKey : "";
  const agentId =
    typeof (result.ctxPayload as { AgentId?: unknown } | undefined)?.AgentId === "string"
      ? ((result.ctxPayload as { AgentId?: string }).AgentId ?? "")
      : "";
  logAt(
    log,
    "info",
    `[bitrix24] inbound turn admitted sender=${normalized.senderStableId} ` +
      `dialog=${normalized.conversationId} agent=${agentId || "?"} ` +
      `session=${sessionKey || "?"} dispatched=${dispatched}`,
  );
  return { status: "dispatched", dispatched, agentId, sessionKey };
}

/** SDK-owned pairing challenge; the code is delivered through our own sendText. */
async function issuePairingChallenge(params: {
  deps: Bitrix24InboundDeps;
  normalized: NormalizedBitrix24Event;
}): Promise<void> {
  const { deps, normalized } = params;
  const issue = createChannelPairingChallengeIssuer({
    channel: BITRIX24_CHANNEL_ID as never,
    accountId: deps.accountId,
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertChannelPairingRequest({
        channel: BITRIX24_CHANNEL_ID as never,
        id,
        accountId: deps.accountId,
        ...(meta ? { meta } : {}),
      }),
  });
  await issue({
    senderId: normalized.senderStableId,
    senderIdLine: `Your Bitrix24 user id: ${normalized.senderStableId}`,
    ...(normalized.senderName ? { meta: { name: normalized.senderName } } : {}),
    sendPairingReply: async (text: string) => {
      await sendBitrix24Text({
        client: deps.client,
        botId: deps.getBotId(),
        botToken: deps.botToken,
        dialogId: normalized.conversationId,
        text,
      });
    },
    onReplyError: (error: unknown) => {
      logAt(deps.log, "warn", `[bitrix24] pairing reply failed ${describeError(error)}`);
    },
  });
}

/**
 * Batch handler handed to the poller. Every event is isolated: one bad event
 * cannot abort the batch or crash the loop.
 */
export function createBitrix24EventHandler(
  deps: Bitrix24InboundDeps,
): (events: unknown[]) => Promise<void> {
  return async (events: unknown[]) => {
    for (const event of events) {
      if (deps.abortSignal?.aborted) {
        return;
      }
      try {
        await handleBitrix24InboundEvent({ deps, raw: (event ?? {}) as Bitrix24RawEvent });
      } catch (error) {
        logAt(deps.log, "error", `[bitrix24] inbound event failed ${describeError(error)}`);
      }
    }
  };
}
