import { describe, expect, it, vi } from "vitest";
import {
  bitrix24EventName,
  createBitrix24EventHandler,
  handleBitrix24InboundEvent,
  isOwnBitrix24Event,
  normalizeBitrix24Event,
  resolveBitrix24ChatKind,
  type Bitrix24InboundDeps,
  type Bitrix24RawEvent,
} from "../src/inbound.js";

function event(overrides: Partial<NonNullable<Bitrix24RawEvent["data"]>> = {}): Bitrix24RawEvent {
  return {
    eventId: "evt-1",
    type: "ONIMBOTV2MESSAGEADD",
    date: "2026-01-15T10:30:00+02:00",
    data: {
      message: { id: 900, authorId: 77, text: "ping" },
      chat: { dialogId: "42", type: "private" },
      user: { id: 77, name: "Test User", bot: false },
      ...overrides,
    },
  };
}

/**
 * Deps that make every path past the loop guard explode, so a test that expects
 * a pre-ingress drop proves the drop happened BEFORE any policy or network work.
 */
function explodingDeps(botId: string, log?: Bitrix24InboundDeps["log"]): Bitrix24InboundDeps {
  return {
    getConfig: () => {
      throw new Error("config must not be read before the loop guard");
    },
    getAccount: () => {
      throw new Error("account must not be read before the loop guard");
    },
    accountId: "default",
    client: {
      call: () => {
        throw new Error("no Bitrix24 call may be made for a dropped event");
      },
      describe: () => ({ host: "fake.bitrix24.test", userId: "1" }),
    },
    getBotId: () => botId,
    botToken: "faketoken",
    ...(log ? { log } : {}),
  };
}

describe("event envelope", () => {
  it("reads the documented `type` field and the tolerated `event` alias", () => {
    expect(bitrix24EventName({ type: "ONIMBOTV2MESSAGEADD" })).toBe("ONIMBOTV2MESSAGEADD");
    expect(bitrix24EventName({ event: "onimbotv2messageadd" })).toBe("ONIMBOTV2MESSAGEADD");
    expect(bitrix24EventName({})).toBe("");
  });

  it("ignores every non-message event before touching config", async () => {
    // ONIMBOTV2JOINCHAT is no longer "ignored": it is logged (see groups.test.ts).
    for (const type of ["ONIMBOTV2REACTIONCHANGE", "ONIMBOTV2MESSAGEDELETE", "ONIMBOTV2CONTEXTGET"]) {
      const outcome = await handleBitrix24InboundEvent({
        deps: explodingDeps("777"),
        raw: { eventId: 5, type, data: {} },
      });
      expect(outcome).toEqual({ status: "dropped", reason: "not_a_message" });
    }
  });
});

describe("chat kind", () => {
  it("treats the documented private/user types as direct", () => {
    expect(resolveBitrix24ChatKind({ type: "private", dialogId: "42" })).toBe("direct");
    expect(resolveBitrix24ChatKind({ type: "user", dialogId: "42" })).toBe("direct");
  });

  it("treats `chat` and anything else as a group", () => {
    expect(resolveBitrix24ChatKind({ type: "chat", dialogId: "chat5" })).toBe("group");
    expect(resolveBitrix24ChatKind({ type: "lines", dialogId: "chat9" })).toBe("group");
  });

  it("falls back to the dialogId shape (numeric = DM, chat<N> = group)", () => {
    expect(resolveBitrix24ChatKind({ dialogId: "42" })).toBe("direct");
    expect(resolveBitrix24ChatKind({ dialogId: "chat5" })).toBe("group");
  });
});

describe("loop guard", () => {
  it("drops the bot's own message (authorId === botId)", () => {
    expect(isOwnBitrix24Event(event(), 77)).toBe(true);
    expect(isOwnBitrix24Event(event(), "77")).toBe(true);
  });

  it("drops any message whose sender is flagged as a bot", () => {
    expect(isOwnBitrix24Event(event({ user: { id: 99, bot: true } }), 77)).toBe(true);
    // `isBot` is the tolerated alias.
    expect(isOwnBitrix24Event(event({ user: { id: 99, isBot: true } }), 77)).toBe(true);
  });

  it("passes a human message from another user", () => {
    const raw = event({ message: { id: 901, authorId: 99, text: "hi" }, user: { id: 99 } });
    expect(isOwnBitrix24Event(raw, 77)).toBe(false);
  });

  it("does not treat an unknown botId as a match", () => {
    const raw = event({ message: { id: 901, authorId: 99, text: "hi" }, user: { id: 99 } });
    expect(isOwnBitrix24Event(raw, "")).toBe(false);
  });

  it("drops own messages BEFORE reaching config, policy or the network", async () => {
    const debug = vi.fn();
    const outcome = await handleBitrix24InboundEvent({
      deps: explodingDeps("77", { debug }),
      raw: event(),
    });
    expect(outcome).toEqual({ status: "dropped", reason: "loop_guard" });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("loop guard"));
  });

  it("drops an event that cannot be mapped to a dialog or sender", async () => {
    const outcome = await handleBitrix24InboundEvent({
      deps: explodingDeps("1"),
      raw: { eventId: "x", type: "ONIMBOTV2MESSAGEADD", data: { message: { text: "hi" } } },
    });
    expect(outcome).toEqual({ status: "dropped", reason: "unmappable" });
  });

  it("never throws out of the batch handler", async () => {
    const error = vi.fn();
    const handler = createBitrix24EventHandler({
      ...explodingDeps("77", { error }),
      getBotId: () => {
        throw new Error("boom");
      },
    });
    await expect(handler([event(), event()])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeBitrix24Event", () => {
  it("maps eventId, text, dialogId and user id", () => {
    const normalized = normalizeBitrix24Event(event());
    expect(normalized).toMatchObject({
      id: "evt-1",
      text: "ping",
      conversationId: "42",
      senderStableId: "77",
      senderName: "Test User",
      senderIsBot: false,
      authorId: "77",
      chatType: "private",
      chatKind: "direct",
    });
  });

  it("parses the documented ISO `date` into epoch millis", () => {
    const normalized = normalizeBitrix24Event(event());
    expect(normalized?.timestampMs).toBe(Date.parse("2026-01-15T10:30:00+02:00"));
  });

  it("falls back to chat.id when dialogId is absent", () => {
    const normalized = normalizeBitrix24Event(
      event({ chat: { id: "chat456" }, user: { id: 5 }, message: { text: "x" } }),
    );
    expect(normalized?.conversationId).toBe("chat456");
  });

  it("returns null without a conversation or sender", () => {
    expect(normalizeBitrix24Event({ data: { chat: { dialogId: "c" } } })).toBeNull();
    expect(normalizeBitrix24Event({ data: { user: { id: 1 } } })).toBeNull();
  });

  it("treats missing text as an empty string rather than undefined", () => {
    const normalized = normalizeBitrix24Event(
      event({ message: { id: 1, authorId: 9 }, user: { id: 9 } }),
    );
    expect(normalized?.text).toBe("");
  });
});
