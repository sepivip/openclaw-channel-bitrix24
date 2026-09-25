// Bot-mention detection for Bitrix24 group messages.
//
// Format, CONFIRMED on a real imbot.v2 `ONIMBOTV2MESSAGEADD` group event from
// a live portal (2026-09-25; the docs do not specify it):
//   data.message.text = "[USER=<botId>]<bot display name>[/USER] <question>"
//   where <botId> equals data.bot.id. data.message.params is [] and there is
//   no structured mentions field, so the text is the only source.
// The same capture confirmed the Bitrix-side gate: for a `bot`-type bot, a
// group message WITHOUT a mention produces no event at all. Core's
// `requireMention` activation gate is therefore a second, independent layer.
//
// Every mention-format rule lives in THIS file and nowhere else.
//
// Fail-closed property: if Bitrix ever changes the format, `mentioned` is
// false for every group message, core's activation gate skips them, and the
// bot stays silent in groups. It can not start answering unmentioned traffic
// because of a detector mismatch.

export type Bitrix24BotMention = {
  /** True when the text contains at least one BB-code mention of this bot. */
  mentioned: boolean;
  /**
   * The text with every mention of this bot removed, plus the separator a
   * user or the Bitrix UI typically puts after it (whitespace and one comma).
   * Mentions of OTHER users are left untouched. Equal to the input when
   * `mentioned` is false.
   */
  text: string;
};

/**
 * Detect and strip mentions of the bot `botId` in a Bitrix message text.
 *
 * Pure: no I/O, no logging. Case-insensitive on the tag name. Only a purely
 * numeric `botId` can match; anything else returns `{ mentioned: false }`.
 * Pass `data.bot.id` (the id the real capture shows inside the tag).
 */
export function detectBitrix24BotMention(text: string, botId: string | number): Bitrix24BotMention {
  const source = typeof text === "string" ? text : "";
  const id = String(botId ?? "").trim();
  if (!source || !/^\d+$/.test(id)) {
    return { mentioned: false, text: source };
  }
  // Groups: (1) whitespace before, (2) optional comma right after the closing
  // tag, (3) whitespace after. The literal `]` after the id means `[USER=42]`
  // can never match `[USER=420]`.
  const pattern = new RegExp(
    `([ \\t]*\\n?[ \\t]*)\\[user=${id}\\][\\s\\S]*?\\[/user\\]([ \\t]*,)?([ \\t]*\\n?[ \\t]*)`,
    "gi",
  );
  let mentioned = false;
  const stripped = source.replace(
    pattern,
    (match: string, before: string, _comma: string | undefined, after: string, offset: number) => {
      mentioned = true;
      if (offset === 0 || offset + match.length === source.length) {
        return "";
      }
      // Keep one separator between the surrounding words; prefer a newline if
      // the mention sat on its own line.
      return `${before}${after}`.includes("\n") ? "\n" : " ";
    },
  );
  if (!mentioned) {
    return { mentioned: false, text: source };
  }
  return { mentioned: true, text: stripped.trim() };
}
