// Synthetic fixtures for the inbound-flow tests. Every id and name here is
// invented; none comes from a real portal.
//
//   bot            9001
//   owner          4101   (in allowFrom and in commands.allowFrom)
//   staff          4102   (in allowFrom only)
//   outsider       4199   (in neither)
//   listed group   chat8801
//   unlisted group chat8802

import { vi } from "vitest";
import type { Bitrix24InboundDeps, Bitrix24RawChat, Bitrix24RawEvent, Bitrix24RawUser } from "../src/inbound.js";
import { resolveBitrix24Account } from "../src/config-schema.js";

export const BOT_ID = "9001";
export const OWNER = 4101;
export const STAFF = 4102;
export const OUTSIDER = 4199;
export const LISTED_GROUP = "chat8801";
export const UNLISTED_GROUP = "chat8802";
export const AGENT_ID = "bitrix24-assistant";

let sequence = 0;

export function mention(text: string): string {
  return `[USER=${BOT_ID}]Test Bot[/USER] ${text}`;
}

/** A group ONIMBOTV2MESSAGEADD that passes the hard guard unless overridden. */
export function groupEvent(opts: {
  text?: string;
  userId?: number;
  dialogId?: string;
  authorId?: number;
  chat?: Partial<Record<keyof Bitrix24RawChat, unknown>>;
  user?: Partial<Record<keyof Bitrix24RawUser, unknown>>;
} = {}): Bitrix24RawEvent {
  sequence += 1;
  const userId = opts.userId ?? OWNER;
  const dialogId = opts.dialogId ?? LISTED_GROUP;
  return {
    eventId: `evt-g-${sequence}`,
    type: "ONIMBOTV2MESSAGEADD",
    date: "2026-01-15T10:30:00+02:00",
    data: {
      bot: { id: Number(BOT_ID), code: "test_bot" },
      message: {
        id: 70_000 + sequence,
        chatId: Number(dialogId.replace(/^chat/, "")) || 0,
        authorId: opts.authorId ?? userId,
        text: opts.text ?? mention("hello"),
        isSystem: false,
      },
      chat: {
        id: Number(dialogId.replace(/^chat/, "")) || 0,
        dialogId,
        name: "Synthetic Group",
        type: "chat",
        messageType: "C",
        owner: OWNER,
        extranet: false,
        containsCollaber: false,
        entityType: "",
        entityId: "",
        ...(opts.chat as Bitrix24RawChat | undefined),
      },
      user: {
        id: userId,
        name: "Synthetic User",
        bot: false,
        extranet: false,
        connector: false,
        externalAuthId: "default",
        ...(opts.user as Bitrix24RawUser | undefined),
      },
    },
  };
}

/** A DM ONIMBOTV2MESSAGEADD from `userId` (dialogId === userId). */
export function dmEvent(opts: {
  text?: string;
  userId?: number;
  chat?: Partial<Record<keyof Bitrix24RawChat, unknown>>;
  user?: Partial<Record<keyof Bitrix24RawUser, unknown>>;
} = {}): Bitrix24RawEvent {
  sequence += 1;
  const userId = opts.userId ?? OWNER;
  return {
    eventId: `evt-d-${sequence}`,
    type: "ONIMBOTV2MESSAGEADD",
    date: "2026-01-15T10:30:00+02:00",
    data: {
      bot: { id: Number(BOT_ID), code: "test_bot" },
      message: { id: 80_000 + sequence, chatId: 55, authorId: userId, text: opts.text ?? "ping", isSystem: false },
      chat: {
        id: 55,
        dialogId: String(userId),
        type: "private",
        messageType: "P",
        ...(opts.chat as Bitrix24RawChat | undefined),
      },
      user: { id: userId, name: "Synthetic User", bot: false, ...(opts.user as Bitrix24RawUser | undefined) },
    },
  };
}

export function joinEvent(opts: {
  dialogId?: string;
  addedBy?: number;
  chat?: Partial<Record<keyof Bitrix24RawChat, unknown>>;
} = {}): Bitrix24RawEvent {
  sequence += 1;
  const dialogId = opts.dialogId ?? LISTED_GROUP;
  return {
    eventId: `evt-j-${sequence}`,
    type: "ONIMBOTV2JOINCHAT",
    date: "2026-01-15T10:30:00+02:00",
    data: {
      bot: { id: Number(BOT_ID), code: "test_bot" },
      dialogId,
      chat: {
        id: Number(dialogId.replace(/^chat/, "")) || 0,
        dialogId,
        name: "Synthetic Group",
        type: "chat",
        messageType: "C",
        extranet: false,
        containsCollaber: false,
        entityType: "",
        ...(opts.chat as Bitrix24RawChat | undefined),
      },
      user: { id: opts.addedBy ?? OWNER, name: "Synthetic User" },
      language: "en",
    },
  };
}

// ---------------------------------------------------------------------------
// REAL EVENT SHAPES (captured on a live portal, 2026-09-25), rebuilt with
// synthetic values. Field names, value types, key sets and oddities (snake_case
// duplicates, params: [], entityType: "") match the capture; every id, name,
// uuid and text is invented.
// ---------------------------------------------------------------------------

/**
 * Shape 4: ONIMBOTV2JOINCHAT for a chat the bot created itself
 * (imbot.v2.Chat.add). `data` keys: bot, chat, dialogId, language, user.
 * `dialogId` sits at the top of `data`; `user` is the BOT
 * (bot: true, externalAuthId: "bot").
 */
export function realShapeJoinEvent(opts: { dialogId?: string } = {}): Bitrix24RawEvent {
  sequence += 1;
  const dialogId = opts.dialogId ?? LISTED_GROUP;
  const chatId = Number(dialogId.replace(/^chat/, "")) || 0;
  return {
    eventId: `evt-rj-${sequence}`,
    type: "ONIMBOTV2JOINCHAT",
    date: "2026-01-15T10:30:00+02:00",
    data: {
      bot: { id: Number(BOT_ID) },
      chat: {
        id: chatId,
        dialogId,
        type: "chat",
        messageType: "C",
        extranet: false,
        containsCollaber: false,
        entityType: "",
        owner: Number(BOT_ID),
      },
      dialogId,
      language: "en",
      user: {
        id: Number(BOT_ID),
        bot: true,
        externalAuthId: "bot",
        extranet: false,
        connector: false,
      },
    },
  };
}

type RealShapeMessageOpts = {
  userId?: number;
  text?: string;
  botId?: number;
};

/** `data.user` exactly as captured (no name field); synthetic id. */
function realShapeUser(userId: number) {
  return {
    id: userId,
    extranet: false,
    bot: false,
    connector: false,
    externalAuthId: "socservices",
    active: true,
  };
}

/** `data.message` exactly as captured, with its snake_case duplicates. */
function realShapeMessage(params: { chatId: number; authorId: number; text: string }) {
  const id = 90_000 + sequence;
  return {
    id,
    chatId: params.chatId,
    authorId: params.authorId,
    isSystem: false,
    text: params.text,
    params: [],
    chat_id: params.chatId,
    author_id: params.authorId,
    uuid: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    forward: null,
    viewedByOthers: false,
    block: null,
  };
}

/**
 * Shape 1: ONIMBOTV2MESSAGEADD in a DM. `data` keys: additionalMessages, bot,
 * chat, language, message, user. `chat.dialogId` is the user id as a string;
 * the chat's owner is the bot; `user.externalAuthId` is "socservices".
 */
export function realShapeDmEvent(opts: RealShapeMessageOpts & { chatId?: number } = {}): Bitrix24RawEvent {
  sequence += 1;
  const userId = opts.userId ?? OWNER;
  const botId = opts.botId ?? Number(BOT_ID);
  const chatId = opts.chatId ?? 55;
  const data = {
    additionalMessages: [],
    bot: { id: botId },
    chat: {
      id: chatId,
      dialogId: String(userId),
      type: "private",
      messageType: "P",
      extranet: false,
      containsCollaber: false,
      entityType: "",
      entityId: "",
      owner: botId,
    },
    language: "en",
    message: realShapeMessage({ chatId, authorId: userId, text: opts.text ?? "hello" }),
    user: realShapeUser(userId),
  };
  return {
    eventId: `evt-rd-${sequence}`,
    type: "ONIMBOTV2MESSAGEADD",
    date: "2026-01-15T10:30:00+02:00",
    data: data as NonNullable<Bitrix24RawEvent["data"]>,
  };
}

/**
 * Shape 2: ONIMBOTV2MESSAGEADD in a group, mentioning the bot. Same `data`
 * keys as a DM; `message.text` starts with "[USER=<botId>]<name>[/USER] "
 * where <botId> equals data.bot.id; `params` is [] (no structured mention).
 */
export function realShapeGroupEvent(opts: RealShapeMessageOpts & { dialogId?: string } = {}): Bitrix24RawEvent {
  sequence += 1;
  const userId = opts.userId ?? OWNER;
  const botId = opts.botId ?? Number(BOT_ID);
  const dialogId = opts.dialogId ?? LISTED_GROUP;
  const chatId = Number(dialogId.replace(/^chat/, "")) || 0;
  const data = {
    additionalMessages: [],
    bot: { id: botId },
    chat: {
      id: chatId,
      dialogId,
      type: "chat",
      messageType: "C",
      extranet: false,
      containsCollaber: false,
      entityType: "",
      owner: botId,
    },
    language: "en",
    message: realShapeMessage({
      chatId,
      authorId: userId,
      text: opts.text ?? `[USER=${botId}]Assistant[/USER] how many warehouses do we have?`,
    }),
    user: realShapeUser(userId),
  };
  return {
    eventId: `evt-rg-${sequence}`,
    type: "ONIMBOTV2MESSAGEADD",
    date: "2026-01-15T10:30:00+02:00",
    data: data as NonNullable<Bitrix24RawEvent["data"]>,
  };
}

/** A full OpenClaw config with the Bitrix24 section under test. */
export function buildConfig(
  section: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): never {
  return {
    bindings: [
      { type: "route", agentId: AGENT_ID, match: { channel: "bitrix24", accountId: "*" } },
    ],
    agents: { entries: { main: { name: "Main" }, [AGENT_ID]: { name: "Test Assistant" } } },
    session: { dmScope: "per-channel-peer" },
    commands: { allowFrom: { bitrix24: [String(OWNER)] } },
    channels: {
      bitrix24: {
        enabled: true,
        webhookUrl: "https://synthetic.bitrix24.test/rest/7/fakefakefake/",
        botToken: "fake-bot-token",
        portalDomain: "bitrix24.test",
        dmPolicy: "allowlist",
        allowFrom: [String(OWNER), String(STAFF)],
        groupPolicy: "allowlist",
        groups: { [LISTED_GROUP]: {} },
        ...section,
      },
    },
    ...extra,
  } as never;
}

export type SentMessage = { dialogId: string; message: string };

export type LogCapture = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  all: () => string[];
};

export function captureLog(): LogCapture {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const all = () =>
    [info, warn, error, debug].flatMap((fn) => fn.mock.calls.map((call) => String(call[0])));
  return { info, warn, error, debug, all };
}

/** Deps with a recording fake client. `cfg` is read through spies. */
export function buildDeps(cfg: never, log: LogCapture = captureLog()) {
  const sent: SentMessage[] = [];
  const calls: string[] = [];
  const getConfig = vi.fn(() => cfg);
  const getAccount = vi.fn(() => resolveBitrix24Account(cfg, "default"));
  const deps: Bitrix24InboundDeps = {
    getConfig,
    getAccount,
    accountId: "default",
    client: {
      call: (async (method: string, params?: Record<string, unknown>) => {
        calls.push(method);
        if (method === "imbot.v2.Chat.Message.send") {
          sent.push({
            dialogId: String(params?.dialogId ?? ""),
            message: String((params?.fields as { message?: unknown } | undefined)?.message ?? ""),
          });
          return { id: 500 + sent.length };
        }
        return true;
      }) as Bitrix24InboundDeps["client"]["call"],
      describe: () => ({ host: "synthetic.bitrix24.test", userId: "7" }),
    },
    getBotId: () => BOT_ID,
    botToken: "fake-bot-token",
    log,
  };
  return { deps, sent, calls, log, getConfig, getAccount };
}
