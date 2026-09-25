// Outbound formatting and delivery.
//
// Bitrix24 chat supports BB-code ONLY; Markdown is not supported
// (apidocs.bitrix24.com .../messages/message-formatting.html). Everything the
// agent produces is therefore escaped first and re-decorated with real BB tags.
//
// Bitrix truncates at 20 000 chars with "(...)"; we chunk at 4 000.

import type { Bitrix24Client } from "./client.js";
import { Bitrix24Error } from "./secrets.js";

export const BITRIX24_CHUNK_LIMIT = 4000;

/**
 * Sentinel used to park extracted spans (code, links) while the rest of the
 * text is bracket-escaped. NUL is stripped from the input first, so a hostile
 * message cannot forge a placeholder.
 */
const MARK = "\u0000";

/**
 * Escape BB-code control characters in UNTRUSTED text.
 *
 * Everything reaching this function is plain text, so both brackets are
 * escaped: intentional tags are inserted afterwards by `markdownToBbCode`,
 * which calls this on the literal spans only.
 */
export function escapeBbCode(text: string): string {
  return text.replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
}

function stripMarks(text: string): string {
  return text.split(MARK).join("");
}

function isSafeLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Convert a Markdown-ish agent reply into Bitrix BB-code.
 *
 * Supported: fenced code blocks, inline code, bold, italic, links, unordered
 * lists. Everything else becomes escaped plain text — no silent pass-through of
 * raw brackets.
 */
export function markdownToBbCode(markdown: string): string {
  const parked: string[] = [];
  const park = (value: string): string => {
    parked.push(value);
    return `${MARK}${parked.length - 1}${MARK}`;
  };

  let text = stripMarks(markdown);

  // 1. Fenced code blocks.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, body: string) =>
    park(`[code]${escapeBbCode(body.replace(/\n$/, ""))}[/code]`),
  );

  // 2. Inline code.
  text = text.replace(/`([^`\n]+)`/g, (_match, body: string) =>
    park(`[code]${escapeBbCode(body)}[/code]`),
  );

  // 3. Links — parked BEFORE bracket escaping, since `[text](url)` uses brackets.
  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    if (!isSafeLinkUrl(url)) {
      return park(escapeBbCode(match));
    }
    const safeLabel = escapeBbCode(label) || escapeBbCode(url);
    return park(`[url=${url.replace(/\]/g, "%5D")}]${safeLabel}[/url]`);
  });

  // 4. Escape everything that survived.
  text = escapeBbCode(text);

  // 5. Emphasis. Bold first so `**x**` is not eaten by the italic rule.
  text = text.replace(/\*\*([^\n*]+)\*\*/g, "[b]$1[/b]");
  text = text.replace(/__([^\n_]+)__/g, "[b]$1[/b]");
  text = text.replace(/(^|[\s(])\*([^\n*]+)\*(?=$|[\s).,!?])/g, "$1[i]$2[/i]");
  text = text.replace(/(^|[\s(])_([^\n_]+)_(?=$|[\s).,!?])/g, "$1[i]$2[/i]");

  // 6. Unordered lists: plain "• " bullets. Bitrix24 chat has NO list tags —
  //    the documented BB set is b/i/u/s/size/color/url/user/chat/code/img — and
  //    `[list]`/`[*]` rendered literally in the 2026-09-15 smoke test on a
  //    live portal. Ordered lists ("1. x") are left as plain text.
  text = text.replace(/^[ \t]*[-*][ \t]+/gm, "• ");

  // 7. Restore parked spans.
  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (_m, index: string) => {
    return parked[Number(index)] ?? "";
  });
}

/** True when `index` falls strictly inside an unterminated `[` ... `]` span. */
function insideBbTag(text: string, index: number): boolean {
  const open = text.lastIndexOf("[", index - 1);
  if (open < 0) {
    return false;
  }
  const close = text.indexOf("]", open + 1);
  return close >= index;
}

/**
 * Find a cut point at or before `limit` that respects paragraph, then line,
 * then word boundaries, and never lands inside a BB tag.
 */
function findCut(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
    window.lastIndexOf(" "),
  ];
  for (const candidate of candidates) {
    if (candidate > 0 && candidate <= limit && !insideBbTag(text, candidate)) {
      return candidate;
    }
  }
  // Hard slice. Walk back out of any open tag.
  let cut = limit;
  while (cut > 1 && insideBbTag(text, cut)) {
    cut -= 1;
  }
  return cut > 0 ? cut : limit;
}

/**
 * Split `text` into chunks of at most `limit` characters, preferring paragraph
 * and line boundaries and never splitting inside a `[tag]`.
 */
export function chunkText(text: string, limit: number = BITRIX24_CHUNK_LIMIT): string[] {
  if (limit <= 0) {
    throw new RangeError("chunkText limit must be positive");
  }
  if (text.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = findCut(rest, limit);
    const head = rest.slice(0, cut);
    chunks.push(head.replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^[ \t]*\n?\n?/, "");
    if (rest.length === 0) {
      break;
    }
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

export type Bitrix24SendTextParams = {
  client: Bitrix24Client;
  botId: number | string;
  botToken: string;
  dialogId: string;
  text: string;
  /** Pass `false` when the text is already BB-code. */
  convertMarkdown?: boolean;
  signal?: AbortSignal;
};

/**
 * Deliver one logical reply as 1..n Bitrix messages.
 * Returns the provider message ids in send order.
 */
export async function sendText(params: Bitrix24SendTextParams): Promise<string[]> {
  const body =
    params.convertMarkdown === false ? params.text : markdownToBbCode(params.text);
  const messageIds: string[] = [];
  for (const chunk of chunkText(body)) {
    const result = await params.client.call<unknown>(
      "imbot.v2.Chat.Message.send",
      {
        botId: params.botId,
        botToken: params.botToken,
        dialogId: params.dialogId,
        fields: { message: chunk },
      },
      params.signal ? { signal: params.signal } : undefined,
    );
    messageIds.push(extractMessageId(result));
  }
  return messageIds;
}

function extractMessageId(result: unknown): string {
  if (typeof result === "number" || typeof result === "string") {
    return String(result);
  }
  const record = (result ?? {}) as { messageId?: unknown; id?: unknown };
  const candidate = record.messageId ?? record.id;
  return candidate === undefined || candidate === null ? "" : String(candidate);
}

/** Timeout for one `imbot.v2.File.upload` call (Bitrix cloud: 60 s per request). */
export const BITRIX24_FILE_UPLOAD_TIMEOUT_MS = 60_000;

export type Bitrix24SendFileParams = {
  client: Bitrix24Client;
  botId: number | string;
  botToken: string;
  /** Target dialog: `{userId}` for a DM, `chat{chatId}` for a group. */
  dialogId: string;
  /** File name with extension. The caller validates it. */
  fileName: string;
  /** File content, Base64 without a `data:` prefix. The caller validates it. */
  contentBase64: string;
  /** Plain text shown with the file. BB-code brackets are escaped here. */
  caption?: string;
  signal?: AbortSignal;
};

export type Bitrix24SendFileResult = {
  fileId: string;
  messageId: string;
};

/**
 * Upload one file into a dialog as the bot: `imbot.v2.File.upload` uploads to
 * the chat's Drive folder, attaches it and posts the message in one call.
 *
 * Request shape per apidocs (imbot.v2/files/file-upload): top-level `botId`,
 * `botToken`, `dialogId`, and `fields.{name, content, message}`. Response:
 * `{ file: { id, ... }, messageId, chatId, dialogId }`.
 *
 * A timeout or transport error is NOT retried (the upload may already have
 * happened); it surfaces as a `Bitrix24Error`. A response without a file id
 * and without a message id is treated as a failure, never as a success.
 */
export async function sendFile(params: Bitrix24SendFileParams): Promise<Bitrix24SendFileResult> {
  const caption = typeof params.caption === "string" ? escapeBbCode(stripMarks(params.caption)) : "";
  const result = await params.client.call<unknown>(
    "imbot.v2.File.upload",
    {
      botId: params.botId,
      botToken: params.botToken,
      dialogId: params.dialogId,
      fields: {
        name: params.fileName,
        content: params.contentBase64,
        ...(caption ? { message: caption } : {}),
      },
    },
    {
      timeoutMs: BITRIX24_FILE_UPLOAD_TIMEOUT_MS,
      retryTransportErrors: false,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  const extracted = extractFileUploadResult(result);
  if (!extracted.fileId && !extracted.messageId) {
    throw new Bitrix24Error({
      method: "imbot.v2.File.upload",
      code: "UPLOAD_UNCONFIRMED",
      description: "imbot.v2.File.upload returned neither a file id nor a message id.",
    });
  }
  return extracted;
}

function idOrEmpty(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.trim())) {
    return value.trim();
  }
  return "";
}

/** `{ file: { id }, messageId }` per apidocs; `fileId` / `message.id` tolerated. */
export function extractFileUploadResult(result: unknown): Bitrix24SendFileResult {
  const record = (result && typeof result === "object" ? result : {}) as {
    file?: { id?: unknown };
    fileId?: unknown;
    messageId?: unknown;
    message?: { id?: unknown };
  };
  return {
    fileId: idOrEmpty(record.file?.id ?? record.fileId),
    messageId: idOrEmpty(record.messageId ?? record.message?.id),
  };
}

export type Bitrix24SendTypingParams = {
  client: Bitrix24Client;
  botId: number | string;
  botToken: string;
  dialogId: string;
  signal?: AbortSignal;
};

/**
 * v2 replacement for the deprecated v1 typing method.
 * Typing + send is 2 calls per reply against a 2 req/s account budget; the
 * client's token bucket (1.5 req/s) absorbs that.
 */
export async function sendTyping(params: Bitrix24SendTypingParams): Promise<void> {
  await params.client.call(
    "imbot.v2.Chat.InputAction.notify",
    {
      botId: params.botId,
      botToken: params.botToken,
      dialogId: params.dialogId,
      action: "writing",
    },
    params.signal ? { signal: params.signal } : undefined,
  );
}
