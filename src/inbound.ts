// Inbound: envelope parsing, loop guard, hard guard, group eligibility, SDK
// ingress, and the `runChannelInboundEvent` adapter that starts an agent turn.
//
// Ordering is load-bearing (design §2.2):
//   0. event type filter        — ONIMBOTV2MESSAGEADD may start a turn;
//                                 ONIMBOTV2JOINCHAT is logged (no reply);
//                                 everything else is ignored
//   1. loop guard               — the bot's own echo never reaches policy
//   2. HARD GUARD (guard.ts)    — extranet / collaber / Open Lines / external
//                                 senders are refused, DMs and groups alike
//   3. group eligibility        — groupPolicy "allowlist" AND listed in `groups`
//   4. mention detection        — groups only (mentions.ts; format confirmed
//                                 on a real v2 event)
//   5. SDK ingress              — core owns dmPolicy / allowFrom / pairing, the
//                                 group sender allowlist and the mention gate
//   6. session isolation        — a group must get its own per-group session
//   7. runChannelInboundEvent   — core owns classify → resolve → record → dispatch
//
// Steps 0-4 and 6 only ever REFUSE; none of them can admit anything. Every
// admit decision is step 5, delegated to `createChannelIngressResolver`, the
// same core evaluator the bundled Telegram channel uses
// (`/app/extensions/telegram/src/ingress.ts`).

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
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { Bitrix24Client } from "./client.js";
import {
  BITRIX24_CHANNEL_ID,
  BITRIX24_GROUP_DIALOG_ID_RE,
  type Bitrix24DmPolicy,
  type ResolvedBitrix24Account,
  type ResolvedBitrix24Group,
} from "./config-schema.js";
import {
  prepareBitrix24ReplyPayload,
  renderBitrix24ReplyText,
  warnReplyDeclined,
  warnReplyMediaDropped,
} from "./delivery.js";
import { evaluateBitrix24ChatGuard, evaluateBitrix24EventGuard } from "./guard.js";
import { detectBitrix24BotMention, type Bitrix24BotMention } from "./mentions.js";
import { Bitrix24Error } from "./secrets.js";
import { sendText as sendBitrix24Text, sendTyping as sendBitrix24Typing } from "./outbound.js";

/** The only event that may start an agent turn. */
export const BITRIX24_MESSAGE_EVENT = "ONIMBOTV2MESSAGEADD";

/** Bot added to (or invited into) a chat. Logged, never answered. */
export const BITRIX24_JOIN_EVENT = "ONIMBOTV2JOINCHAT";

/**
 * `data.chat` of `ONIMBOTV2MESSAGEADD` / `ONIMBOTV2JOINCHAT`, narrowed to what
 * we read. Guard-relevant fields are `unknown` on purpose: guard.ts decides
 * what shape counts as safe.
 */
export type Bitrix24RawChat = {
  id?: string | number;
  dialogId?: string | number;
  /** `chat`, `open`, `channel`, `openChannel`, `copilot`, `thread`, `generalChannel`; DMs `private`. */
  type?: string;
  name?: string;
  /** `C` chat, `O` open, `P` private, … */
  messageType?: unknown;
  owner?: unknown;
  extranet?: unknown;
  containsCollaber?: unknown;
  /** e.g. `LINES` for Open Lines / Open Channels. */
  entityType?: unknown;
  entityId?: unknown;
};

/** `data.user` of `ONIMBOTV2MESSAGEADD` (the author) or `ONIMBOTV2JOINCHAT` (who added the bot). */
export type Bitrix24RawUser = {
  id?: string | number;
  name?: string;
  bot?: unknown;
  /** Tolerated alias of `bot`. */
  isBot?: unknown;
  extranet?: unknown;
  /** Open Lines connector, i.e. an external customer. */
  connector?: unknown;
  /** `default`, `bot`, `email`, `replica`, … */
  externalAuthId?: unknown;
};

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
    chat?: Bitrix24RawChat;
    user?: Bitrix24RawUser;
    /** `ONIMBOTV2JOINCHAT` carries the dialog id at the top level of `data`. */
    dialogId?: string | number;
    language?: string;
  };
};

export type Bitrix24ChatKind = "direct" | "group";

export type NormalizedBitrix24Event = {
  /** `eventId` → turn id / idempotency key. */
  id: string;
  timestampMs: number | undefined;
  /** `data.message.text` → rawText. For groups the agent gets the mention-stripped text. */
  text: string;
  /** `data.chat.dialogId` → conversation id (`{userId}` for DMs, `chat{id}` for groups). */
  conversationId: string;
  /** `data.user.id`, falling back to `data.message.authorId` → sender stable id. */
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

/** An id or enum value that is safe to put in a log line; anything else is masked. */
function logToken(value: string | undefined): string {
  if (!value) {
    return "?";
  }
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : "<invalid>";
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
export function resolveBitrix24ChatKind(chat: Bitrix24RawChat | undefined): Bitrix24ChatKind {
  const type = typeof chat?.type === "string" ? chat.type.trim().toLowerCase() : "";
  if (type === "private" || type === "user" || type === "dialog") {
    return "direct";
  }
  if (type) {
    // "chat", "open", "channel", "lines", … are all non-direct.
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
 * `data.user.id === botId` also counts on its own, so the bot's own message
 * (for example a file it posted) is dropped even when `authorId` is absent.
 */
export function isOwnBitrix24Event(raw: Bitrix24RawEvent, botId: string | number): boolean {
  const authorId = asId(raw.data?.message?.authorId);
  const self = asId(botId);
  if (self && authorId && authorId === self) {
    return true;
  }
  const userId = asId(raw.data?.user?.id);
  if (self && userId && userId === self) {
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

/**
 * The Gateway's pairing-store writer,
 * `PluginRuntime["channel"]["pairing"]["upsertPairingRequest"]`. In 2026.9.4
 * it forwards these fields to the same `upsertChannelPairingRequest` the
 * deprecated `openclaw/plugin-sdk/conversation-runtime` barrel exports.
 */
export type Bitrix24UpsertPairingRequest = (params: {
  channel: string;
  id: string;
  accountId: string;
  meta?: Record<string, string | undefined>;
}) => Promise<{ code: string; created: boolean }>;

export type Bitrix24InboundDeps = {
  /** Live config snapshot. Re-read per batch so a hot reload is picked up. */
  getConfig: () => OpenClawConfig;
  /** Live account projection (dmPolicy, allowFrom, groupPolicy, groups, bot identity). */
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
  /**
   * Pairing-store writer injected by the Gateway. Used only under
   * dmPolicy "pairing". Without it a pairing challenge fails closed: nothing
   * is stored and no code is sent.
   */
  upsertPairingRequest?: Bitrix24UpsertPairingRequest;
  log?: Bitrix24Log;
  /** The account's stop signal. Cancels the typing indicator only, never a reply. */
  abortSignal?: AbortSignal;
};

export type Bitrix24DropReason =
  | "not_a_message"
  | "join_chat"
  | "loop_guard"
  | "unmappable"
  | "guard_refused"
  | "group_disabled"
  | "group_not_listed"
  | "bot_id_unknown"
  | "not_mentioned"
  | "blocked"
  | "pairing"
  | "group_session_not_isolated";

export type Bitrix24InboundOutcome =
  | {
      status: "dropped";
      reason: Bitrix24DropReason;
      /** Machine-readable sub-reason (guard rule or core ingress reason code). */
      detail?: string;
    }
  | { status: "dispatched"; dispatched: boolean; agentId: string; sessionKey: string };

export type Bitrix24Route = {
  agentId: string;
  accountId: string;
  sessionKey: string;
  mainSessionKey: string;
  dmScope?: NonNullable<ReturnType<typeof resolveAgentRoute>["dmScope"]>;
  peer: { kind: Bitrix24ChatKind; id: string };
};

/**
 * Resolve the agent and session for one conversation.
 *
 * DM peer = the sender id; group peer = the group dialog id (`chat<N>`), so a
 * group gets `agent:<agent>:bitrix24:group:chat<N>` under core's default
 * `session.groupScope: "per-group"`, separate from every DM key.
 */
export function resolveBitrix24Route(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatKind: Bitrix24ChatKind;
  conversationId: string;
  senderStableId: string;
}): Bitrix24Route {
  const { cfg, accountId } = params;
  const peer = {
    kind: params.chatKind,
    id: params.chatKind === "direct" ? params.senderStableId : params.conversationId,
  };
  // bindings[] decide the agent. `matchedBy` records which rule won.
  const route = resolveAgentRoute({ cfg, channel: BITRIX24_CHANNEL_ID, accountId, peer });
  const sessionKey =
    route.sessionKey ||
    buildAgentSessionKey({
      agentId: route.agentId,
      ...(cfg.session?.mainKey ? { mainKey: cfg.session.mainKey } : {}),
      channel: BITRIX24_CHANNEL_ID,
      accountId,
      peer,
      ...(route.dmScope ? { dmScope: route.dmScope } : {}),
      ...(cfg.session?.identityLinks ? { identityLinks: cfg.session.identityLinks } : {}),
    });
  return {
    agentId: route.agentId,
    accountId: route.accountId,
    sessionKey,
    mainSessionKey: route.mainSessionKey,
    ...(route.dmScope ? { dmScope: route.dmScope } : {}),
    peer,
  };
}

/**
 * True only when a group's session is its own: not the agent's main session
 * and keyed by this group's dialog id. `session.groupScope: "main"` (or a
 * binding override to it) would fold group turns into the main session, which
 * a DM may share; that is refused rather than dispatched.
 */
export function isIsolatedBitrix24GroupSession(route: Bitrix24Route, dialogId: string): boolean {
  const key = route.sessionKey.trim().toLowerCase();
  if (!key || key === route.mainSessionKey.trim().toLowerCase()) {
    return false;
  }
  return key.endsWith(`:group:${dialogId.trim().toLowerCase()}`);
}

/** Mention facts handed to core's context for a group turn. */
type Bitrix24MentionAccess = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  requireMention: boolean;
  effectiveWasMentioned?: boolean;
};

/** Build the turn plan handed back to core from `adapter.resolveTurn`. */
async function buildTurnPlan(params: {
  deps: Bitrix24InboundDeps;
  cfg: OpenClawConfig;
  normalized: NormalizedBitrix24Event;
  route: Bitrix24Route;
  /** Text for the agent and for command parsing (mention-stripped in groups). */
  agentText: string;
  mentions: Bitrix24MentionAccess | undefined;
  ingress: unknown;
}): Promise<ChannelInboundTurnPlan<"provider_message_sending">> {
  const { deps, cfg, normalized, route } = params;
  const accountId = deps.accountId;
  const peerKind = normalized.chatKind;
  const sessionKey = route.sessionKey;
  const dialogId = normalized.conversationId;
  const botId = deps.getBotId();
  const warn = (message: string) => logAt(deps.log, "warn", message);

  const ctxPayload = buildChannelInboundEventContext({
    channel: BITRIX24_CHANNEL_ID,
    accountId,
    ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
    ...(normalized.timestampMs === undefined ? {} : { timestamp: normalized.timestampMs }),
    from: `${BITRIX24_CHANNEL_ID}:${dialogId}`,
    // The real author: `data.user.id`, falling back to `message.authorId`.
    // `commands.allowFrom` (owner-only commands) is matched against this id.
    sender: {
      id: normalized.senderStableId,
      ...(normalized.senderName ? { name: normalized.senderName } : {}),
      isBot: normalized.senderIsBot,
    },
    conversation: {
      kind: peerKind,
      id: dialogId,
      ...(normalized.chatLabel ? { label: normalized.chatLabel } : {}),
      routePeer: route.peer,
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
      // InboundEventKind is "user_request" | "room_event"; a DM or an admitted
      // (mentioned) group message is a request.
      inboundEventKind: "user_request",
      rawBody: normalized.text,
      body: params.agentText,
      bodyForAgent: params.agentText,
      // BodyForCommands: core parses `/status` etc. from this, so `@bot /status`
      // must arrive here as `/status`.
      commandBody: params.agentText,
    },
    ...(params.mentions ? { access: { mentions: params.mentions } } : {}),
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
      // Core calls this first, then deliverWithProviderMessageSending with the
      // result; `null` means "nothing visible" and is recorded by core as
      // `no_visible_payload`. See delivery.ts for the degrade rules.
      preparePayload: (payload, info) => prepareBitrix24ReplyPayload(payload, info, warn),
      deliverWithProviderMessageSending: async (payload, info) => {
        // Re-applied here so the hook is safe on its own: for an already
        // prepared payload this is the identity on `text`.
        const rendered = renderBitrix24ReplyText(payload);
        if (!rendered.visible) {
          warnReplyDeclined(warn, info.kind, payload, rendered.reason);
          return { visibleReplySent: false };
        }
        if (rendered.mediaDropped) {
          warnReplyMediaDropped(warn, info.kind, payload);
        }
        info.assertPlatformSendAuthorized();
        await info.onPlatformSendDispatch();
        // Not tied to the account's stop signal: a stop waits for the turn in
        // flight and acknowledges its event as handled, so its reply must
        // still go out. The client's own timeout bounds the send.
        const messageIds = await sendBitrix24Text({
          client: deps.client,
          botId,
          botToken: deps.botToken,
          dialogId,
          text: rendered.text,
        });
        return { messageIds, visibleReplySent: messageIds.length > 0, content: rendered.text };
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
 * Who added the bot, for the join log line. When the bot created the chat
 * itself (the bot-side "Chat add" method), Bitrix reports the BOT as `data.user`
 * (`bot: true`, `externalAuthId: "bot"`, id = the bot id): that is `self`.
 * Another bot is `bot:<id>`. The sender guard is deliberately NOT applied
 * here: a join never starts a turn, it is only logged.
 */
function describeJoinAdder(params: { deps: Bitrix24InboundDeps; data: Bitrix24RawEvent["data"] }): string {
  const adderId = asId(params.data?.user?.id);
  if (!adderId) {
    return "?";
  }
  let selfId = "";
  try {
    selfId = asId(params.deps.getBotId());
  } catch {
    /* fall back to the event's own bot id */
  }
  const eventBotId = asId(params.data?.bot?.id);
  if (adderId === selfId || adderId === eventBotId) {
    return "self";
  }
  const flaggedBot = params.data?.user?.bot === true || params.data?.user?.isBot === true;
  return flaggedBot ? `bot:${logToken(adderId)}` : logToken(adderId);
}

/**
 * `ONIMBOTV2JOINCHAT`: one info line, no reply, no Bitrix call. States whether
 * the chat would pass the hard guard and whether it is listed in `groups`, so
 * an operator can decide from the log alone whether to list it.
 */
export function handleBitrix24JoinEvent(params: {
  deps: Bitrix24InboundDeps;
  raw: Bitrix24RawEvent;
}): void {
  const data = params.raw.data;
  const dialogId = asId(data?.dialogId) || asId(data?.chat?.dialogId);
  const chat = { ...(data?.chat ?? {}), ...(dialogId ? { dialogId } : {}) };
  const kind = resolveBitrix24ChatKind(chat);
  const verdict = evaluateBitrix24ChatGuard({ kind, dialogId, chat });
  let listed = "unknown";
  let groupPolicy = "unknown";
  try {
    const account = params.deps.getAccount();
    groupPolicy = account.groupPolicy;
    listed = String(Boolean(dialogId && account.groups[dialogId]));
  } catch {
    /* a config problem must not turn a log line into a crash */
  }
  logAt(
    params.deps.log,
    "info",
    `[bitrix24] bot added to chat dialog=${logToken(dialogId)} ` +
      `addedBy=${describeJoinAdder({ deps: params.deps, data })} ` +
      `chatType=${logToken(typeof data?.chat?.type === "string" ? data.chat.type : undefined)} ` +
      `kind=${kind} guard=${verdict.allowed ? "pass" : `refuse:${verdict.reason}`} ` +
      `listed=${listed} groupPolicy=${groupPolicy} (no reply sent)`,
  );
}

/**
 * Run one Bitrix event through loop guard → hard guard → group eligibility →
 * SDK ingress → the inbound kernel.
 *
 * Never throws for a single bad event: the poller must keep draining.
 */
export async function handleBitrix24InboundEvent(params: {
  deps: Bitrix24InboundDeps;
  raw: Bitrix24RawEvent;
}): Promise<Bitrix24InboundOutcome> {
  const { deps, raw } = params;
  const log = deps.log;

  // 0. Only message-add events can start a turn. The join event is logged at
  //    info; everything else (reaction, delete, …) is acknowledged by the
  //    offset and ignored.
  const eventName = bitrix24EventName(raw);
  if (eventName === BITRIX24_JOIN_EVENT) {
    handleBitrix24JoinEvent({ deps, raw });
    return { status: "dropped", reason: "join_chat" };
  }
  if (eventName !== BITRIX24_MESSAGE_EVENT) {
    logAt(log, "debug", `[bitrix24] ignoring event ${eventName ? logToken(eventName) : "<unnamed>"}`);
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
  const dialogLog = logToken(normalized.conversationId);
  const senderLog = logToken(normalized.senderStableId);
  const isGroup = normalized.chatKind === "group";

  // 2. HARD GUARD, fail closed, for DMs and groups. Before config, ingress and
  //    any reply.
  const verdict = evaluateBitrix24EventGuard({
    kind: normalized.chatKind,
    dialogId: normalized.conversationId,
    chat: raw.data?.chat,
    user: raw.data?.user,
    authorId: raw.data?.message?.authorId,
  });
  if (!verdict.allowed) {
    logAt(
      log,
      "info",
      `[bitrix24] ignored message (hard guard) kind=${normalized.chatKind} ` +
        `dialog=${dialogLog} sender=${senderLog} reason=${verdict.reason}`,
    );
    return { status: "dropped", reason: "guard_refused", detail: verdict.reason };
  }

  const account = deps.getAccount();
  const cfg = deps.getConfig();

  // 3. Group eligibility: groupPolicy "allowlist" AND listed in `groups`.
  let group: ResolvedBitrix24Group | undefined;
  if (isGroup) {
    const ignoreGroup = (reason: Bitrix24DropReason): Bitrix24InboundOutcome => {
      logAt(
        log,
        "info",
        `[bitrix24] ignored group message dialog=${dialogLog} sender=${senderLog} ` +
          `reason=${reason} groupPolicy=${account.groupPolicy}`,
      );
      return { status: "dropped", reason };
    };
    if (account.groupPolicy !== "allowlist") {
      return ignoreGroup("group_disabled");
    }
    group = BITRIX24_GROUP_DIALOG_ID_RE.test(normalized.conversationId)
      ? account.groups[normalized.conversationId]
      : undefined;
    if (!group) {
      return ignoreGroup("group_not_listed");
    }
    // Without a numeric bot id the mention can not be detected, and core only
    // enforces requireMention when canDetectMention is true: refuse instead.
    if (!/^\d+$/.test(asId(botId))) {
      return ignoreGroup("bot_id_unknown");
    }
  }

  // 4. Mentions (groups only). DMs keep their text verbatim, as before.
  const mention: Bitrix24BotMention = group
    ? detectBitrix24BotMention(normalized.text, botId)
    : { mentioned: false, text: normalized.text };

  // 5. Core-owned ingress: dmPolicy, allowFrom, pairing store, access groups,
  //    the group sender allowlist and the mention (activation) gate. The
  //    plugin supplies facts; it does not decide.
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
    groupPolicy: account.groupPolicy,
    allowFrom: account.allowFrom,
    // In groups the sender allowlist IS channels.bitrix24.allowFrom.
    groupAllowFrom: isGroup ? account.allowFrom : [],
    ...(group
      ? {
          mentionFacts: { canDetectMention: true, wasMentioned: mention.mentioned },
          // allowTextCommands:false => no mention bypass, not even for commands.
          policy: {
            activation: { requireMention: group.requireMention, allowTextCommands: false },
          },
        }
      : {}),
  });

  if (resolved.ingress.decision === "pairing") {
    await issuePairingChallenge({ deps, normalized }).catch((error: unknown) => {
      logAt(log, "warn", `[bitrix24] pairing challenge failed ${describeError(error)}`);
    });
    return { status: "dropped", reason: "pairing" };
  }
  // `admission`, not `decision`: an activation skip (not mentioned) is
  // decision "allow" with admission "skip".
  if (resolved.ingress.admission !== "dispatch") {
    if (isGroup) {
      const reason: Bitrix24DropReason =
        resolved.ingress.admission === "skip" ? "not_mentioned" : "blocked";
      logAt(
        log,
        "info",
        `[bitrix24] ignored group message dialog=${dialogLog} sender=${senderLog} ` +
          `reason=${reason} ingress=${resolved.ingress.reasonCode}`,
      );
      return { status: "dropped", reason, detail: resolved.ingress.reasonCode };
    }
    logAt(
      log,
      "warn",
      `[bitrix24] Blocked unauthorized bitrix24 sender ${senderLog} ` +
        `(dmPolicy=${dmPolicy}, reason=${resolved.ingress.reasonCode})`,
    );
    return { status: "dropped", reason: "blocked" };
  }

  // 6. Session: a group must get its own per-group session, never a DM's or
  //    the main one.
  const route = resolveBitrix24Route({
    cfg,
    accountId: deps.accountId,
    chatKind: normalized.chatKind,
    conversationId: normalized.conversationId,
    senderStableId: normalized.senderStableId,
  });
  if (isGroup && !isIsolatedBitrix24GroupSession(route, normalized.conversationId)) {
    logAt(
      log,
      "warn",
      `[bitrix24] refused group message dialog=${dialogLog}: its session is not a per-group ` +
        `session (check session.groupScope and binding session overrides)`,
    );
    return { status: "dropped", reason: "group_session_not_isolated" };
  }

  const mentions: Bitrix24MentionAccess | undefined = group
    ? {
        canDetectMention: true,
        wasMentioned: mention.mentioned,
        requireMention: group.requireMention,
        ...(resolved.activationAccess.effectiveWasMentioned === undefined
          ? {}
          : { effectiveWasMentioned: resolved.activationAccess.effectiveWasMentioned }),
      }
    : undefined;

  // 7. Core owns ingest → classify → preflight → resolve → record → dispatch.
  const result = await runChannelInboundEvent<NormalizedBitrix24Event>({
    channel: BITRIX24_CHANNEL_ID,
    accountId: deps.accountId,
    raw: normalized,
    adapter: {
      ingest: (input: NormalizedBitrix24Event) => ({
        id: input.id,
        ...(input.timestampMs === undefined ? {} : { timestamp: input.timestampMs }),
        rawText: input.text,
        textForAgent: mention.text,
        textForCommands: mention.text,
        raw: input,
      }),
      resolveTurn: async () =>
        await buildTurnPlan({
          deps,
          cfg,
          normalized,
          route,
          agentText: mention.text,
          mentions,
          ingress: resolved,
        }),
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
    `[bitrix24] inbound turn admitted kind=${normalized.chatKind} sender=${senderLog} ` +
      `dialog=${dialogLog} agent=${agentId || "?"} ` +
      `session=${sessionKey || "?"} dispatched=${dispatched}`,
  );
  return { status: "dispatched", dispatched, agentId, sessionKey };
}

/**
 * SDK-owned pairing challenge; the request is stored through the Gateway's
 * pairing writer and the code is delivered through our own sendText.
 */
async function issuePairingChallenge(params: {
  deps: Bitrix24InboundDeps;
  normalized: NormalizedBitrix24Event;
}): Promise<void> {
  const { deps, normalized } = params;
  const upsertPairingRequest = deps.upsertPairingRequest;
  if (!upsertPairingRequest) {
    throw new Error("no Gateway pairing store (channel runtime missing); pairing request not stored");
  }
  const issue = createChannelPairingChallengeIssuer({
    channel: BITRIX24_CHANNEL_ID as never,
    accountId: deps.accountId,
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertPairingRequest({
        channel: BITRIX24_CHANNEL_ID,
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
 *
 * A stop (a channel restart after a config change, or shutdown) never makes it
 * skip an event: the poller acknowledges what it handed over once this
 * returns, so a skipped event would be acknowledged but never handled. Where a
 * stop may end a batch is the poller's call, between two events (poller.ts).
 */
export function createBitrix24EventHandler(
  deps: Bitrix24InboundDeps,
): (events: unknown[]) => Promise<void> {
  return async (events: unknown[]) => {
    for (const event of events) {
      try {
        await handleBitrix24InboundEvent({ deps, raw: (event ?? {}) as Bitrix24RawEvent });
      } catch (error) {
        logAt(deps.log, "error", `[bitrix24] inbound event failed ${describeError(error)}`);
      }
    }
  };
}
