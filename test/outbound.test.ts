import { describe, expect, it, vi } from "vitest";
import { createBitrix24Client, type Bitrix24Client } from "../src/client.js";
import {
  BITRIX24_CHUNK_LIMIT,
  BITRIX24_FILE_UPLOAD_TIMEOUT_MS,
  chunkText,
  escapeBbCode,
  extractFileUploadResult,
  markdownToBbCode,
  sendFile,
} from "../src/outbound.js";
import { Bitrix24Error } from "../src/secrets.js";

type RecordedCall = { method: string; params: Record<string, unknown>; options: unknown };

function recordingClient(result: unknown = { file: { id: 138 }, messageId: 123, chatId: 5, dialogId: "chat5" }) {
  const calls: RecordedCall[] = [];
  const client: Bitrix24Client = {
    call: (async (method: string, params?: Record<string, unknown>, options?: unknown) => {
      calls.push({ method, params: params ?? {}, options });
      return result;
    }) as Bitrix24Client["call"],
    describe: () => ({ host: "synthetic.bitrix24.test", userId: "7" }),
  };
  return { client, calls };
}

describe("sendFile (imbot.v2.File.upload)", () => {
  it("sends the documented request shape with a 60 s timeout and no transport retry", async () => {
    const { client, calls } = recordingClient();
    const result = await sendFile({
      client,
      botId: "9001",
      botToken: "fake-bot-token",
      dialogId: "chat8801",
      fileName: "stock-all-2026-01-15.xlsx",
      contentBase64: "UEsDBA==",
      caption: "Stock across all warehouses",
    });
    expect(result).toEqual({ fileId: "138", messageId: "123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("imbot.v2.File.upload");
    expect(calls[0]?.params).toEqual({
      botId: "9001",
      botToken: "fake-bot-token",
      dialogId: "chat8801",
      fields: {
        name: "stock-all-2026-01-15.xlsx",
        content: "UEsDBA==",
        message: "Stock across all warehouses",
      },
    });
    expect(calls[0]?.options).toEqual({ timeoutMs: 60_000, retryTransportErrors: false });
    expect(BITRIX24_FILE_UPLOAD_TIMEOUT_MS).toBe(60_000);
  });

  it("escapes BB-code brackets in the caption (plain text only)", async () => {
    const { client, calls } = recordingClient();
    await sendFile({
      client,
      botId: 1,
      botToken: "t",
      dialogId: "42",
      fileName: "a.xlsx",
      contentBase64: "UEsDBA==",
      caption: "Stock at [b]Main[/b] [url=https://evil.example]x[/url]\u0000",
    });
    const message = (calls[0]?.params.fields as { message: string }).message;
    expect(message).toBe(
      "Stock at &#91;b&#93;Main&#91;/b&#93; &#91;url=https://evil.example&#93;x&#91;/url&#93;",
    );
    expect(message).not.toMatch(/[[\]]/);
  });

  it("omits fields.message when there is no caption", async () => {
    const { client, calls } = recordingClient();
    await sendFile({ client, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" });
    expect(calls[0]?.params.fields).toEqual({ name: "a.xlsx", content: "UEsDBA==" });
  });

  it("passes the caller's abort signal through", async () => {
    const { client, calls } = recordingClient();
    const controller = new AbortController();
    await sendFile({
      client,
      botId: 1,
      botToken: "t",
      dialogId: "42",
      fileName: "a.xlsx",
      contentBase64: "UEsDBA==",
      signal: controller.signal,
    });
    expect((calls[0]?.options as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it.each([
    ["an empty object", {}],
    ["true", true],
    ["null", null],
    ["undefined (an unreadable 200 body)", undefined],
    ["no ids", { file: {}, messageId: null }],
    ["a file id only", { file: { id: 138 } }],
    ["a fileId alias only", { fileId: "138" }],
    ["messageId 0", { file: { id: 138 }, messageId: 0 }],
    ["messageId null", { file: { id: 138 }, messageId: null }],
    ["messageId \"\"", { file: { id: 138 }, messageId: "" }],
    ["messageId \"0\"", { file: { id: 138 }, messageId: "0" }],
    ["messageId \"000\"", { file: { id: 138 }, messageId: "000" }],
    ["a negative messageId", { file: { id: 138 }, messageId: -5 }],
    ["a fractional messageId", { file: { id: 138 }, messageId: 1.5 }],
    ["a non-numeric messageId", { file: { id: 138 }, messageId: "abc" }],
    ["message.id 0", { file: { id: 138 }, message: { id: 0 } }],
  ])("treats a response with %s as UPLOAD_UNCONFIRMED, never a success", async (_label, result) => {
    // Not recordingClient: its default parameter would replace `undefined`.
    const client: Bitrix24Client = {
      call: (async () => result) as Bitrix24Client["call"],
      describe: () => ({ host: "h", userId: "1" }),
    };
    await expect(
      sendFile({ client, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" }),
    ).rejects.toMatchObject({ code: "UPLOAD_UNCONFIRMED", method: "imbot.v2.File.upload", status: undefined });
  });

  it.each([
    [{ file: { id: 138 }, messageId: 123 }, "123"],
    [{ file: { id: 138 }, messageId: "123" }, "123"],
    [{ file: { id: 138 }, messageId: "0100" }, "0100"],
    [{ messageId: 7 }, "7"],
    [{ message: { id: "10" } }, "10"],
  ])("accepts a positive message id (%j)", async (result, messageId) => {
    const { client } = recordingClient(result);
    await expect(
      sendFile({ client, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" }),
    ).resolves.toMatchObject({ messageId });
  });

  it("propagates a Bitrix error (FILE_UPLOAD_FAILED)", async () => {
    const client: Bitrix24Client = {
      call: (async () => {
        throw new Bitrix24Error({
          method: "imbot.v2.File.upload",
          code: "FILE_UPLOAD_FAILED",
          description: "File upload failed",
          status: 400,
        });
      }) as Bitrix24Client["call"],
      describe: () => ({ host: "h", userId: "1" }),
    };
    await expect(
      sendFile({ client, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" }),
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_FAILED" });
  });

  it("posts JSON to <base>imbot.v2.File.upload through the real client, once, even on a timeout", async () => {
    const base = "https://acme.example.bitrix24.eu/rest/42/s3cr3tT0kenAAAA/";
    const okFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`${base}imbot.v2.File.upload`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        dialogId: "42",
        fields: { name: "a.xlsx", content: "UEsDBA==" },
      });
      return new Response(JSON.stringify({ result: { file: { id: 1 }, messageId: 2 } }), { status: 200 });
    });
    const client = createBitrix24Client({
      baseUrl: base,
      portalDomains: ["example.bitrix24.eu"],
      fetchImpl: okFetch as unknown as typeof fetch,
    });
    await expect(
      sendFile({ client, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" }),
    ).resolves.toEqual({ fileId: "1", messageId: "2" });

    const failingFetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const failing = createBitrix24Client({
      baseUrl: base,
      portalDomains: ["example.bitrix24.eu"],
      fetchImpl: failingFetch as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(
      sendFile({ client: failing, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" }),
    ).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });

  it("extracts ids from the documented response and tolerated aliases", () => {
    expect(extractFileUploadResult({ file: { id: 138 }, messageId: 123 })).toEqual({ fileId: "138", messageId: "123" });
    expect(extractFileUploadResult({ fileId: "9", message: { id: "10" } })).toEqual({ fileId: "9", messageId: "10" });
    expect(extractFileUploadResult({ messageId: "not an id!" })).toEqual({ fileId: "", messageId: "" });
    // The message id must be a positive integer; the file id alone is kept but proves nothing.
    expect(extractFileUploadResult({ file: { id: 138 }, messageId: 0 })).toEqual({ fileId: "138", messageId: "" });
    expect(extractFileUploadResult({ file: { id: 138 }, messageId: "abc" })).toEqual({ fileId: "138", messageId: "" });
    expect(extractFileUploadResult({ messageId: " 42 " })).toEqual({ fileId: "", messageId: "42" });
  });

  it("a bare 503 or 429 on File.upload reaches the caller after one request (no retry)", async () => {
    for (const status of [503, 429]) {
      const fetchImpl = vi.fn(async () => new Response("<html>busy</html>", { status }));
      const client = createBitrix24Client({
        baseUrl: "https://acme.example.bitrix24.eu/rest/42/s3cr3tT0kenAAAA/",
        portalDomains: ["example.bitrix24.eu"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      });
      await expect(
        sendFile({ client, botId: 1, botToken: "t", dialogId: "42", fileName: "a.xlsx", contentBase64: "UEsDBA==" }),
      ).rejects.toMatchObject({ code: `http_${status}`, status });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe("escapeBbCode", () => {
  it("escapes both brackets so untrusted text cannot forge tags", () => {
    expect(escapeBbCode("[b]bold[/b]")).toBe("&#91;b&#93;bold&#91;/b&#93;");
    expect(escapeBbCode("plain")).toBe("plain");
  });

  it("leaves no raw bracket behind", () => {
    const out = escapeBbCode("a[b]c[/d]e][f");
    expect(out).not.toMatch(/[[\]]/);
  });
});

describe("markdownToBbCode", () => {
  it("converts bold, italic and inline code", () => {
    expect(markdownToBbCode("**loud**")).toBe("[b]loud[/b]");
    expect(markdownToBbCode("_soft_")).toBe("[i]soft[/i]");
    expect(markdownToBbCode("use `npm ci` now")).toBe("use [code]npm ci[/code] now");
  });

  it("converts fenced code blocks and escapes their content", () => {
    const out = markdownToBbCode("```js\nconst a = arr[0];\n```");
    expect(out).toContain("[code]");
    expect(out).toContain("&#91;0&#93;");
    expect(out).toContain("[/code]");
  });

  it("converts links and rejects non-http schemes", () => {
    expect(markdownToBbCode("[site](https://example.com)")).toBe(
      "[url=https://example.com]site[/url]",
    );
    const unsafe = markdownToBbCode("[x](javascript:alert(1))");
    expect(unsafe).not.toContain("[url=");
    expect(unsafe).not.toMatch(/(^|[^&#\d])\[/);
  });

  it("converts unordered lists", () => {
    // Bitrix24 chat has no list BB tags; [list]/[*] render literally (smoke test 2026-09-15).
    const out = markdownToBbCode("- one\n- two\n");
    expect(out).toBe("• one\n• two\n");
    expect(out).not.toContain("[list]");
    expect(out).not.toContain("[*]");
    expect(markdownToBbCode("  * nested\n1. keep numbers")).toBe("• nested\n1. keep numbers");
  });

  it("escapes everything else to plain text", () => {
    const out = markdownToBbCode("danger [url=https://evil.example]click[/url]");
    expect(out).toContain("&#91;url=https://evil.example&#93;");
    expect(out).not.toContain("[url=https://evil.example]");
  });

  it("cannot be tricked by a forged placeholder sentinel", () => {
    const NUL = "\u0000";
    const forged = `${NUL}0${NUL} and \`real\``;
    const out = markdownToBbCode(forged);
    expect(out).toContain("[code]real[/code]");
    expect(out).not.toContain(NUL);
  });
});

describe("chunkText", () => {
  it("splits 12 000 characters into 3 chunks", () => {
    const chunks = chunkText("a".repeat(12_000));
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(BITRIX24_CHUNK_LIMIT);
    }
    expect(chunks.join("")).toHaveLength(12_000);
  });

  it("returns one chunk for short text and none for empty text", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("")).toEqual([]);
  });

  it("prefers paragraph boundaries", () => {
    const paragraph = `${"x".repeat(3000)}\n\n${"y".repeat(3000)}`;
    const chunks = chunkText(paragraph, 4000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("x".repeat(3000));
    expect(chunks[1]).toBe("y".repeat(3000));
  });

  it("prefers line boundaries when there is no blank line", () => {
    const lines = `${"x".repeat(3000)}\n${"y".repeat(3000)}`;
    const chunks = chunkText(lines, 4000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("x".repeat(3000));
  });

  it("never splits inside a BB tag", () => {
    // Build text so that a naive cut at the limit would land inside `[url=...]`.
    const tag = "[url=https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]link[/url]";
    const text = `${"z".repeat(3990)}${tag}${"w".repeat(3000)}`;
    const chunks = chunkText(text, 4000);
    for (const chunk of chunks) {
      const opens = (chunk.match(/\[/g) ?? []).length;
      const closes = (chunk.match(/\]/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    expect(chunks.join("")).toContain(tag);
  });

  it("rejects a non-positive limit", () => {
    expect(() => chunkText("abc", 0)).toThrow(RangeError);
  });
});
