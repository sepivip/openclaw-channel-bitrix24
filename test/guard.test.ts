// Hard guard, as pure functions. The same rules are exercised end to end
// (before config, ingress and reply) in groups.test.ts.

import { describe, expect, it } from "vitest";
import {
  BITRIX24_DENIED_EXTERNAL_AUTH_IDS,
  evaluateBitrix24ChatGuard,
  evaluateBitrix24EventGuard,
  evaluateBitrix24SenderGuard,
  type Bitrix24GuardChat,
  type Bitrix24GuardUser,
} from "../src/guard.js";

/** A group chat that passes every rule. Synthetic values only. */
const SAFE_GROUP: Bitrix24GuardChat = {
  type: "chat",
  messageType: "C",
  extranet: false,
  containsCollaber: false,
  entityType: "",
};

const SAFE_USER: Bitrix24GuardUser = {
  id: 4101,
  extranet: false,
  connector: false,
  bot: false,
  externalAuthId: "default",
};

function group(chat: Partial<Record<keyof Bitrix24GuardChat, unknown>>) {
  return evaluateBitrix24ChatGuard({ kind: "group", dialogId: "chat8801", chat: { ...SAFE_GROUP, ...chat } });
}

describe("chat guard: groups", () => {
  it("passes a plain internal group chat", () => {
    expect(group({})).toEqual({ allowed: true });
  });

  it.each([
    [{ extranet: true }, "chat_extranet"],
    [{ extranet: "Y" }, "chat_extranet"],
    [{ extranet: undefined }, "chat_extranet_unknown"],
    [{ extranet: null }, "chat_extranet_unknown"],
    [{ extranet: "N" }, "chat_extranet_unknown"],
    [{ containsCollaber: true }, "chat_contains_collaber"],
    [{ containsCollaber: undefined }, "chat_collaber_unknown"],
    [{ entityType: "LINES" }, "chat_entity_linked"],
    [{ entityType: "CRM" }, "chat_entity_linked"],
    [{ entityType: 7 }, "chat_entity_linked"],
    [{ type: "open" }, "chat_type_not_allowed"],
    [{ type: "channel" }, "chat_type_not_allowed"],
    [{ type: "openChannel" }, "chat_type_not_allowed"],
    [{ type: "generalChannel" }, "chat_type_not_allowed"],
    [{ type: "copilot" }, "chat_type_not_allowed"],
    [{ type: "thread" }, "chat_type_not_allowed"],
    [{ type: undefined }, "chat_type_not_allowed"],
    [{ type: "CHAT" }, "chat_type_not_allowed"],
    [{ messageType: "O" }, "chat_message_type_not_allowed"],
    [{ messageType: "P" }, "chat_message_type_not_allowed"],
  ])("refuses %o with %s", (chat, reason) => {
    expect(group(chat)).toEqual({ allowed: false, reason });
  });

  it("accepts a group whose messageType is absent (only a present, non-C value refuses)", () => {
    expect(group({ messageType: undefined })).toEqual({ allowed: true });
  });

  it("refuses a missing chat object entirely", () => {
    expect(evaluateBitrix24ChatGuard({ kind: "group", dialogId: "chat8801", chat: undefined })).toEqual({
      allowed: false,
      reason: "chat_type_not_allowed",
    });
  });
});

describe("chat guard: DMs keep today's behaviour for normal users", () => {
  it("passes a DM with no extranet/collaber fields at all", () => {
    expect(
      evaluateBitrix24ChatGuard({ kind: "direct", dialogId: "4101", chat: { type: "private" } }),
    ).toEqual({ allowed: true });
    expect(evaluateBitrix24ChatGuard({ kind: "direct", dialogId: "4101", chat: undefined })).toEqual({
      allowed: true,
    });
  });

  it("refuses an entity-linked DM (Open Lines)", () => {
    expect(
      evaluateBitrix24ChatGuard({
        kind: "direct",
        dialogId: "4101",
        chat: { type: "private", entityType: "LINES" },
      }),
    ).toEqual({ allowed: false, reason: "chat_entity_linked" });
  });

  it("refuses a DM chat explicitly flagged extranet or containing a collaber", () => {
    expect(
      evaluateBitrix24ChatGuard({ kind: "direct", dialogId: "4101", chat: { extranet: true } }),
    ).toEqual({ allowed: false, reason: "chat_extranet" });
    expect(
      evaluateBitrix24ChatGuard({ kind: "direct", dialogId: "4101", chat: { containsCollaber: true } }),
    ).toEqual({ allowed: false, reason: "chat_contains_collaber" });
  });

  it("refuses a 'direct' event whose dialogId is not a user id", () => {
    expect(
      evaluateBitrix24ChatGuard({ kind: "direct", dialogId: "chat8801", chat: { type: "private" } }),
    ).toEqual({ allowed: false, reason: "dm_dialog_id_not_numeric" });
  });
});

describe("sender guard (DMs and groups)", () => {
  it("passes a normal employee", () => {
    expect(evaluateBitrix24SenderGuard(SAFE_USER)).toEqual({ allowed: true });
    // Absent optional fields are fine.
    expect(evaluateBitrix24SenderGuard({ id: 4101 })).toEqual({ allowed: true });
    expect(evaluateBitrix24SenderGuard(undefined)).toEqual({ allowed: true });
  });

  it.each([
    [{ extranet: true }, "sender_extranet"],
    [{ connector: true }, "sender_connector"],
    [{ bot: true }, "sender_bot"],
    [{ isBot: true }, "sender_bot"],
    [{ externalAuthId: "email" }, "sender_external_auth"],
    [{ externalAuthId: "bot" }, "sender_external_auth"],
    [{ externalAuthId: "replica" }, "sender_external_auth"],
    [{ externalAuthId: "imconnector" }, "sender_external_auth"],
    // Case and padding do not dodge the denylist.
    [{ externalAuthId: "EMAIL" }, "sender_external_auth"],
    [{ externalAuthId: " imconnector " }, "sender_external_auth"],
  ])("refuses %o with %s", (user, reason) => {
    expect(evaluateBitrix24SenderGuard({ ...SAFE_USER, ...user })).toEqual({ allowed: false, reason });
  });

  it("the denylist is exactly the documented external types", () => {
    expect([...BITRIX24_DENIED_EXTERNAL_AUTH_IDS]).toEqual(["email", "replica", "bot", "imconnector"]);
  });

  // Regression: real employees sign in with externalAuthId "socservices"
  // (observed on a live portal); the old "anything but default" rule refused
  // their DMs. Any value outside the denylist passes THIS rule.
  it.each(["socservices", "default", "Default", "some_future_provider", "", undefined, null, 7])(
    "passes externalAuthId %o",
    (externalAuthId) => {
      expect(evaluateBitrix24SenderGuard({ ...SAFE_USER, externalAuthId })).toEqual({ allowed: true });
    },
  );

  it("still refuses a socservices sender flagged extranet, connector or bot", () => {
    for (const flag of ["extranet", "connector", "bot"] as const) {
      expect(
        evaluateBitrix24SenderGuard({ ...SAFE_USER, externalAuthId: "socservices", [flag]: true }).allowed,
      ).toBe(false);
    }
  });
});

describe("event guard", () => {
  it("checks the chat before the sender", () => {
    expect(
      evaluateBitrix24EventGuard({
        kind: "group",
        dialogId: "chat8801",
        chat: { ...SAFE_GROUP, extranet: true },
        user: { ...SAFE_USER, connector: true },
      }),
    ).toEqual({ allowed: false, reason: "chat_extranet" });
  });

  it("refuses a group message whose user.id and message.authorId disagree", () => {
    expect(
      evaluateBitrix24EventGuard({
        kind: "group",
        dialogId: "chat8801",
        chat: SAFE_GROUP,
        user: SAFE_USER,
        authorId: 4102,
      }),
    ).toEqual({ allowed: false, reason: "sender_author_mismatch" });
    expect(
      evaluateBitrix24EventGuard({
        kind: "group",
        dialogId: "chat8801",
        chat: SAFE_GROUP,
        user: SAFE_USER,
        authorId: "4101",
      }),
    ).toEqual({ allowed: true });
  });

  it("applies the sender rules to DMs", () => {
    expect(
      evaluateBitrix24EventGuard({
        kind: "direct",
        dialogId: "4101",
        chat: { type: "private" },
        user: { ...SAFE_USER, extranet: true },
      }),
    ).toEqual({ allowed: false, reason: "sender_extranet" });
  });
});
