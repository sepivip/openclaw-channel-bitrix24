import { describe, expect, it } from "vitest";
import {
  BITRIX24_CHUNK_LIMIT,
  chunkText,
  escapeBbCode,
  markdownToBbCode,
} from "../src/outbound.js";

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
