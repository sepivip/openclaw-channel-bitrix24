// FAKE BITRIX24 PORTAL — development and offline testing only.
//
// NOT part of `dist/`, never shipped, never loaded by the plugin. It exists so
// the poll → ingress → send loop can be exercised with zero network egress and
// zero real credentials. Every value in here is obviously fake.
//
// Implements exactly the five allowlisted imbot.v2 methods, plus a tiny control
// surface under /__test/ used by the tests and by the throwaway e2e run:
//
//   POST /rest/<userId>/<secret>/imbot.v2.Bot.register
//   POST /rest/<userId>/<secret>/imbot.v2.Bot.update
//   POST /rest/<userId>/<secret>/imbot.v2.Event.get
//   POST /rest/<userId>/<secret>/imbot.v2.Chat.Message.send
//   POST /rest/<userId>/<secret>/imbot.v2.Chat.InputAction.notify
//
//   POST /__test/enqueue   { userId, text, dialogId?, chatType?, authorId?, isBot?, raw? }
//   GET  /__test/sent      -> { sent: [ { dialogId, message, botId, at } ] }
//   GET  /__test/calls     -> { calls: [ { method, at } ], counts: { <method>: n } }
//   POST /__test/reset     -> clears queue, sent, calls (keeps registered bots)
//
// Standalone:  node test/fake-bitrix/server.mjs        (PORT, BOT_TOKEN, REST_SECRET, REST_USER_ID)

import { createServer } from "node:http";

const DEFAULT_BOT_TOKEN = "faketoken";
const DEFAULT_SECRET = "FAKEFAKEFAKE";
const DEFAULT_USER_ID = "1";

const ALLOWED_METHODS = new Set([
  "imbot.v2.Bot.register",
  "imbot.v2.Bot.update",
  "imbot.v2.Event.get",
  "imbot.v2.Chat.Message.send",
  "imbot.v2.Chat.InputAction.notify",
]);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function bitrixError(res, status, error, description) {
  json(res, status, { error, error_description: description });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) {
      throw new Error("body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * @param {{ port?: number, host?: string, botToken?: string, secret?: string, userId?: string, log?: (msg: string) => void }} [options]
 */
export function createFakeBitrix(options = {}) {
  const botToken = options.botToken ?? DEFAULT_BOT_TOKEN;
  const secret = options.secret ?? DEFAULT_SECRET;
  const userId = options.userId ?? DEFAULT_USER_ID;
  const log = options.log ?? (() => {});

  const state = {
    /** @type {Map<string, { id: number, code: string, eventMode: string, properties: Record<string, unknown> }>} */
    botsByCode: new Map(),
    nextBotId: 777,
    /** @type {Array<{ eventId: number, type: string, date: string, data: unknown }>} */
    events: [],
    nextEventId: 1001,
    /** @type {Array<{ dialogId: string, message: string, botId: string, at: number }>} */
    sent: [],
    /** @type {Array<{ method: string, at: number }>} */
    calls: [],
    /** @type {Array<{ dialogId: string, action: string }>} */
    typing: [],
    /** Offsets the poller acknowledged, newest last. */
    /** @type {number[]} */
    acks: [],
  };

  function counts() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const call of state.calls) {
      out[call.method] = (out[call.method] ?? 0) + 1;
    }
    return out;
  }

  function buildMessageEvent(input) {
    const eventId = state.nextEventId++;
    if (input.raw && typeof input.raw === "object") {
      return { eventId, ...input.raw };
    }
    const senderId = Number(input.userId ?? 42);
    const chatType = input.chatType ?? "private";
    const dialogId = String(input.dialogId ?? senderId);
    const authorId = Number(input.authorId ?? senderId);
    return {
      eventId,
      type: input.type ?? "ONIMBOTV2MESSAGEADD",
      date: new Date().toISOString(),
      data: {
        bot: { id: state.nextBotId - 1, code: "openclaw_bot", eventMode: "fetch" },
        message: {
          id: 9000 + eventId,
          chatId: 5,
          authorId,
          date: new Date().toISOString(),
          text: String(input.text ?? "ping"),
          isSystem: false,
        },
        chat: {
          id: 5,
          dialogId,
          type: chatType,
          name: chatType === "private" ? "" : "Fake Group",
        },
        user: {
          id: senderId,
          active: true,
          name: input.name ?? `Fake User ${senderId}`,
          bot: input.isBot === true,
          type: "employee",
        },
        language: "en",
      },
    };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      bitrixError(res, 500, "INTERNAL_ERROR", String(error?.message ?? error));
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://fake-bitrix.invalid");
    const pathname = url.pathname;

    // ---- control surface -------------------------------------------------
    if (pathname === "/__test/enqueue" && req.method === "POST") {
      const body = await readJsonBody(req);
      const event = buildMessageEvent(body);
      state.events.push(event);
      log(`[fake-bitrix] enqueued event ${event.eventId} (${event.type})`);
      return json(res, 200, { ok: true, eventId: event.eventId });
    }
    if (pathname === "/__test/sent" && req.method === "GET") {
      return json(res, 200, { sent: state.sent });
    }
    if (pathname === "/__test/calls" && req.method === "GET") {
      return json(res, 200, { calls: state.calls, counts: counts(), acks: state.acks });
    }
    if (pathname === "/__test/typing" && req.method === "GET") {
      return json(res, 200, { typing: state.typing });
    }
    if (pathname === "/__test/reset" && req.method === "POST") {
      state.events = [];
      state.sent = [];
      state.calls = [];
      state.typing = [];
      state.acks = [];
      return json(res, 200, { ok: true });
    }

    // ---- REST surface ----------------------------------------------------
    const match = /^\/rest\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match) {
      return bitrixError(res, 404, "ERROR_NOT_FOUND", "Unknown path.");
    }
    const [, pathUserId, pathSecret, methodRaw] = match;
    const method = decodeURIComponent(methodRaw).replace(/\/+$/, "");
    state.calls.push({ method, at: Date.now() });

    if (pathUserId !== userId || pathSecret !== secret) {
      return bitrixError(res, 401, "INVALID_CREDENTIALS", "Invalid webhook credentials.");
    }
    if (!ALLOWED_METHODS.has(method)) {
      return bitrixError(
        res,
        404,
        "ERROR_METHOD_NOT_FOUND",
        `The method ${method} is not implemented by this fake portal.`,
      );
    }

    const params = await readJsonBody(req);
    const suppliedToken =
      typeof params.botToken === "string"
        ? params.botToken
        : typeof params?.fields?.botToken === "string"
          ? params.fields.botToken
          : "";
    if (!suppliedToken) {
      return bitrixError(res, 401, "BOT_TOKEN_NOT_SPECIFIED", "Bot token is required.");
    }
    if (suppliedToken !== botToken) {
      return bitrixError(res, 401, "BOT_OWNERSHIP_ERROR", "Bot token does not match this bot.");
    }

    if (method === "imbot.v2.Bot.register") {
      const fields = params.fields ?? {};
      const code = String(fields.code ?? "");
      if (!code) {
        return bitrixError(res, 400, "ERROR_ARGUMENT", "fields.code is required.");
      }
      const existing = state.botsByCode.get(code);
      const bot = existing ?? {
        id: state.nextBotId++,
        code,
        eventMode: String(fields.eventMode ?? "fetch"),
        properties: fields.properties ?? {},
      };
      state.botsByCode.set(code, bot);
      log(`[fake-bitrix] Bot.register code=${code} id=${bot.id} eventMode=${bot.eventMode}`);
      return json(res, 200, {
        result: {
          bot: {
            id: bot.id,
            code: bot.code,
            type: "bot",
            isHidden: false,
            isSupportOpenline: false,
            isReactionsEnabled: true,
            backgroundId: null,
            language: "en",
            moduleId: "rest",
            eventMode: bot.eventMode,
            countMessage: 0,
            countCommand: 0,
            countChat: 0,
            countUser: 0,
          },
          users: [],
        },
      });
    }

    if (method === "imbot.v2.Bot.update") {
      return json(res, 200, { result: true });
    }

    if (method === "imbot.v2.Event.get") {
      const rawOffset = params.offset;
      const offset = rawOffset === undefined || rawOffset === null ? 0 : Number(rawOffset);
      if (Number.isFinite(offset) && offset > 0) {
        state.acks.push(offset);
      }
      // "offset — Confirms all events with IDs less than the specified value."
      // Events are deliberately NOT pruned here: the offset filter alone decides
      // what is redelivered, so a poller that forgot its offset would visibly
      // replay (which is exactly what the restart test checks).
      const limit = Math.max(1, Math.min(1000, Number(params.limit ?? 100)));
      const pending = state.events.filter(
        (event) => !Number.isFinite(offset) || event.eventId >= offset,
      );
      const page = pending.slice(0, limit);
      const hasMore = pending.length > page.length;
      const lastId = page.length > 0 ? page[page.length - 1].eventId : undefined;
      const nextOffset =
        lastId !== undefined ? lastId + 1 : offset > 0 ? offset : state.nextEventId;
      return json(res, 200, { result: { events: page, nextOffset, hasMore } });
    }

    if (method === "imbot.v2.Chat.Message.send") {
      const dialogId = String(params.dialogId ?? "");
      const message = String(params.fields?.message ?? "");
      if (!dialogId) {
        return bitrixError(res, 400, "ERROR_ARGUMENT", "dialogId is required.");
      }
      const id = 500 + state.sent.length;
      state.sent.push({ dialogId, message, botId: String(params.botId ?? ""), at: Date.now() });
      log(`[fake-bitrix] Message.send dialog=${dialogId} chars=${message.length}`);
      return json(res, 200, { result: { id, uuidMap: {} } });
    }

    if (method === "imbot.v2.Chat.InputAction.notify") {
      state.typing.push({
        dialogId: String(params.dialogId ?? ""),
        action: String(params.action ?? ""),
      });
      return json(res, 200, { result: true });
    }

    return bitrixError(res, 500, "UNREACHABLE", "Allowlisted method without a handler.");
  }

  return {
    state,
    counts,
    server,
    /** @returns {Promise<{ origin: string, restBase: string, port: number }>} */
    async listen() {
      await new Promise((resolve) => {
        server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve(undefined));
      });
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const host = options.host && options.host !== "0.0.0.0" ? options.host : "127.0.0.1";
      const origin = `http://${host}:${port}`;
      return { origin, restBase: `${origin}/rest/${userId}/${secret}/`, port };
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
      });
    },
  };
}

// Standalone entry point for the throwaway container run.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const fake = createFakeBitrix({
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "0.0.0.0",
    botToken: process.env.BOT_TOKEN ?? DEFAULT_BOT_TOKEN,
    secret: process.env.REST_SECRET ?? DEFAULT_SECRET,
    userId: process.env.REST_USER_ID ?? DEFAULT_USER_ID,
    log: (message) => console.log(message),
  });
  const { origin, restBase } = await fake.listen();
  console.log(`[fake-bitrix] listening on ${origin}`);
  console.log(`[fake-bitrix] rest base ${restBase}`);
}
