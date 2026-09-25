// Mention detection. The `[USER=<botId>]Name[/USER] <text>` form is confirmed
// by a real v2 group event (2026-09-25). The first test reproduces that event's
// text exactly, with a synthetic bot id and display name.

import { describe, expect, it } from "vitest";
import { detectBitrix24BotMention } from "../src/mentions.js";

const BOT = "9001";

describe("real v2 group event shape (synthetic id and name)", () => {
  it("'[USER=42]Assistant[/USER] how many warehouses do we have?' with bot id 42", () => {
    // Real shape: message.text starts with the bot's BB-code mention whose id
    // equals data.bot.id, then one space and the question; params is [].
    expect(detectBitrix24BotMention("[USER=42]Assistant[/USER] how many warehouses do we have?", 42)).toEqual({
      mentioned: true,
      text: "how many warehouses do we have?",
    });
    expect(detectBitrix24BotMention("[USER=42]Assistant[/USER] how many warehouses do we have?", "42")).toEqual({
      mentioned: true,
      text: "how many warehouses do we have?",
    });
  });

  it("the same text addressed to a different bot id is not a mention of this bot", () => {
    expect(detectBitrix24BotMention("[USER=42]Assistant[/USER] how many warehouses do we have?", 43)).toEqual({
      mentioned: false,
      text: "[USER=42]Assistant[/USER] how many warehouses do we have?",
    });
  });
});

describe("detectBitrix24BotMention", () => {
  it("detects a leading mention and strips it", () => {
    expect(detectBitrix24BotMention("[USER=9001]Test Bot[/USER] hello there", BOT)).toEqual({
      mentioned: true,
      text: "hello there",
    });
  });

  it("is case-insensitive on the tag and accepts a numeric bot id", () => {
    expect(detectBitrix24BotMention("[user=9001]Test Bot[/user] hi", 9001)).toEqual({
      mentioned: true,
      text: "hi",
    });
    expect(detectBitrix24BotMention("[User=9001]Test Bot[/uSeR] hi", BOT).mentioned).toBe(true);
  });

  it("handles the comma the Bitrix UI puts after a picked mention", () => {
    expect(detectBitrix24BotMention("[USER=9001]Test Bot[/USER], what is the balance?", BOT)).toEqual({
      mentioned: true,
      text: "what is the balance?",
    });
    expect(detectBitrix24BotMention("[USER=9001]Test Bot[/USER] , spaced comma", BOT).text).toBe(
      "spaced comma",
    );
  });

  it("strips a mention in the middle or at the end without gluing words", () => {
    expect(detectBitrix24BotMention("please [USER=9001]Test Bot[/USER] check this", BOT).text).toBe(
      "please check this",
    );
    expect(detectBitrix24BotMention("thanks [USER=9001]Test Bot[/USER]", BOT).text).toBe("thanks");
    expect(detectBitrix24BotMention("line one\n[USER=9001]Test Bot[/USER]\nline two", BOT).text).toBe(
      "line one\nline two",
    );
  });

  it("turns '@bot /status' into a parseable command", () => {
    expect(detectBitrix24BotMention("[USER=9001]Test Bot[/USER] /status", BOT).text).toBe("/status");
    expect(detectBitrix24BotMention("  [USER=9001]Test Bot[/USER]   /model list  ", BOT).text).toBe(
      "/model list",
    );
  });

  it("strips every mention of the bot, keeps mentions of other users", () => {
    const result = detectBitrix24BotMention(
      "[USER=9001]Test Bot[/USER] ask [USER=4102]Synthetic User B[/USER] too [USER=9001]Test Bot[/USER]",
      BOT,
    );
    expect(result).toEqual({
      mentioned: true,
      text: "ask [USER=4102]Synthetic User B[/USER] too",
    });
  });

  it("does not match another user's id, including a longer id with the same prefix", () => {
    expect(detectBitrix24BotMention("[USER=4102]Synthetic User B[/USER] hi", BOT)).toEqual({
      mentioned: false,
      text: "[USER=4102]Synthetic User B[/USER] hi",
    });
    expect(detectBitrix24BotMention("[USER=90011]Someone[/USER] hi", BOT).mentioned).toBe(false);
    expect(detectBitrix24BotMention("[USER=900]Someone[/USER] hi", BOT).mentioned).toBe(false);
  });

  it("does not treat a plain-text name or an @handle as a mention", () => {
    expect(detectBitrix24BotMention("@Test Bot hello", BOT).mentioned).toBe(false);
    expect(detectBitrix24BotMention("Test Bot, hello", BOT).mentioned).toBe(false);
    expect(detectBitrix24BotMention("[USER=9001]unterminated", BOT).mentioned).toBe(false);
  });

  it("returns mentioned=false for an unusable bot id (never a wildcard)", () => {
    for (const botId of ["", "  ", "abc", "90 01", ".*"]) {
      expect(detectBitrix24BotMention("[USER=9001]Test Bot[/USER] hi", botId)).toEqual({
        mentioned: false,
        text: "[USER=9001]Test Bot[/USER] hi",
      });
    }
  });

  it("leaves text untouched when there is no mention", () => {
    expect(detectBitrix24BotMention("  plain text  ", BOT)).toEqual({
      mentioned: false,
      text: "  plain text  ",
    });
    expect(detectBitrix24BotMention("", BOT)).toEqual({ mentioned: false, text: "" });
  });

  it("a bare mention leaves an empty body", () => {
    expect(detectBitrix24BotMention("[USER=9001]Test Bot[/USER]", BOT)).toEqual({
      mentioned: true,
      text: "",
    });
  });
});
