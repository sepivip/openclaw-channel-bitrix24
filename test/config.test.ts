import { beforeEach, describe, expect, it } from "vitest";
import {
  BITRIX24_DEFAULT_DM_POLICY,
  inspectBitrix24Account,
  listBitrix24AccountIds,
  normalizeBitrix24AllowFrom,
  resetBitrix24ConfigNotices,
  resolveBitrix24Account,
} from "../src/config-schema.js";
import { Bitrix24ConfigError } from "../src/secrets.js";

type AnyConfig = Parameters<typeof resolveBitrix24Account>[0];

function cfg(section: Record<string, unknown>): AnyConfig {
  return { channels: { bitrix24: section } } as unknown as AnyConfig;
}

beforeEach(() => {
  resetBitrix24ConfigNotices();
});

describe("fail-closed config resolution", () => {
  it("throws when enabled but botToken is missing", () => {
    expect(() =>
      resolveBitrix24Account(
        cfg({
          enabled: true,
          webhookUrl: "https://acme.example.bitrix24.eu/rest/42/tok/",
          portalDomain: "example.bitrix24.eu",
        }),
      ),
    ).toThrow(Bitrix24ConfigError);
  });

  it("throws when enabled but webhookUrl is missing", () => {
    expect(() =>
      resolveBitrix24Account(
        cfg({ enabled: true, botToken: "abc", portalDomain: "example.bitrix24.eu" }),
      ),
    ).toThrow(/webhookUrl/);
  });

  it("resolves cleanly when disabled, even with no secrets at all", () => {
    const account = resolveBitrix24Account(cfg({}));
    expect(account.enabled).toBe(false);
    expect(account.webhookUrlStatus).toBe("missing");
    expect(account.botTokenStatus).toBe("missing");
    expect(account.dmPolicy).toBe(BITRIX24_DEFAULT_DM_POLICY);
    expect(account.allowFrom).toEqual([]);
    expect(account.groupPolicy).toBe("disabled");
  });

  it("defaults enabled to false when the key is absent or non-boolean", () => {
    expect(resolveBitrix24Account(cfg({})).enabled).toBe(false);
    expect(resolveBitrix24Account(cfg({ enabled: "true" })).enabled).toBe(false);
    expect(resolveBitrix24Account(cfg({ enabled: 1 })).enabled).toBe(false);
  });

  it("keeps poll and bot defaults from the design", () => {
    const account = resolveBitrix24Account(cfg({}));
    expect(account.poll).toEqual({ idleMs: 15_000, activeMs: 3_000 });
    expect(account.bot).toEqual({
      code: "openclaw_bot",
      name: "Assistant",
      color: "PURPLE",
      workPosition: "AI Assistant",
    });
  });

  it("lists a single default account", () => {
    expect(listBitrix24AccountIds(cfg({}))).toEqual(["default"]);
  });
});

describe("allowFrom normalization", () => {
  it("keeps numeric ids and drops everything else with a warning", () => {
    const warnings: string[] = [];
    const result = normalizeBitrix24AllowFrom(
      ["1", "42", 7, "", "  ", "*", "user@example.com", "12a", null],
      (m) => warnings.push(m),
    );
    expect(result).toEqual(["1", "42", "7"]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("never treats a wildcard as an allowance", () => {
    expect(normalizeBitrix24AllowFrom(["*"])).toEqual([]);
  });

  it("treats a non-array as empty", () => {
    expect(normalizeBitrix24AllowFrom("42")).toEqual([]);
    expect(normalizeBitrix24AllowFrom(undefined)).toEqual([]);
  });
});

describe("dmPolicy", () => {
  it("falls back to allowlist for an unknown policy, and has no 'open'", () => {
    expect(resolveBitrix24Account(cfg({ dmPolicy: "open" })).dmPolicy).toBe("allowlist");
    expect(resolveBitrix24Account(cfg({ dmPolicy: "pairing" })).dmPolicy).toBe("pairing");
    expect(resolveBitrix24Account(cfg({ dmPolicy: "disabled" })).dmPolicy).toBe("disabled");
  });
});

describe("inspectAccount", () => {
  it("never throws and reports unconfigured state without resolving secrets", () => {
    const inspected = inspectBitrix24Account(cfg({ enabled: true }));
    expect(inspected.enabled).toBe(true);
    expect(inspected.configured).toBe(false);
    expect(inspected.webhookUrlStatus).toBe("missing");
    expect(inspected.stateReason).toBeUndefined();
  });

  it("requires a portalDomain before it calls an account configured", () => {
    const inspected = inspectBitrix24Account(
      cfg({ enabled: true, webhookUrl: "https://x/rest/1/t/", botToken: "t" }),
    );
    expect(inspected.portalDomainConfigured).toBe(false);
    expect(inspected.configured).toBe(false);
  });
});
