import { describe, expect, it } from "vitest";
import {
  Bitrix24ConfigError,
  Bitrix24Error,
  fingerprintSecret,
  isBitrix24ConfigError,
  isBitrix24Error,
  redactUrlSecret,
} from "../src/secrets.js";

const TOKEN = "s3cr3tT0kenAAAA";
const URL_WITH_SECRET = `https://acme.example.bitrix24.eu/rest/42/${TOKEN}/`;

describe("fingerprintSecret", () => {
  it("is 16 hex chars, stable, and not the secret", () => {
    const fp = fingerprintSecret(TOKEN);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toBe(fingerprintSecret(TOKEN));
    expect(fp).not.toContain(TOKEN);
  });

  it("differs for different secrets", () => {
    expect(fingerprintSecret("a")).not.toBe(fingerprintSecret("b"));
  });
});

describe("redactUrlSecret", () => {
  it("replaces the token path segment and never leaks it", () => {
    const redacted = redactUrlSecret(URL_WITH_SECRET);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain("/rest/42/***");
    expect(redacted).toContain("acme.example.bitrix24.eu");
  });

  it("redacts a URL without a trailing slash", () => {
    expect(redactUrlSecret(`https://acme.example.bitrix24.eu/rest/42/${TOKEN}`)).not.toContain(
      TOKEN,
    );
  });

  it("redacts deeper path segments too", () => {
    const redacted = redactUrlSecret(
      `https://acme.example.bitrix24.eu/rest/42/${TOKEN}/imbot.v2.Event.get`,
    );
    expect(redacted).not.toContain(TOKEN);
  });

  it("drops query, fragment and userinfo", () => {
    const redacted = redactUrlSecret(
      `https://u:${TOKEN}@acme.example.bitrix24.eu/rest/42/${TOKEN}/?q=${TOKEN}#${TOKEN}`,
    );
    expect(redacted).not.toContain(TOKEN);
  });

  it("collapses to *** for anything unparseable or non-string", () => {
    expect(redactUrlSecret("not a url")).toBe("***");
    expect(redactUrlSecret(undefined)).toBe("***");
    expect(redactUrlSecret(null)).toBe("***");
    expect(redactUrlSecret(123)).toBe("***");
    expect(redactUrlSecret("")).toBe("***");
  });

  it("redacts every segment when the shape is unexpected", () => {
    const redacted = redactUrlSecret(`https://acme.example.bitrix24.eu/other/${TOKEN}/x`);
    expect(redacted).not.toContain(TOKEN);
  });
});

describe("error types", () => {
  it("Bitrix24Error exposes only log-safe fields", () => {
    const error = new Bitrix24Error({
      method: "imbot.v2.Event.get",
      code: "BOT_NOT_FOUND",
      description: "no such bot",
      status: 400,
    });
    expect(isBitrix24Error(error)).toBe(true);
    expect(error.toLogFields()).toEqual({
      method: "imbot.v2.Event.get",
      code: "BOT_NOT_FOUND",
      description: "no such bot",
      status: 400,
    });
    expect(JSON.stringify(error.toLogFields())).not.toContain(TOKEN);
  });

  it("Bitrix24ConfigError carries the config path", () => {
    const error = new Bitrix24ConfigError("missing", "channels.bitrix24.botToken");
    expect(isBitrix24ConfigError(error)).toBe(true);
    expect(error.configPath).toBe("channels.bitrix24.botToken");
    expect(error.message).not.toContain(TOKEN);
  });
});
