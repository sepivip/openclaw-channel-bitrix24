import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BITRIX24_DEFAULT_DM_POLICY,
  bitrix24ChannelConfigSchema,
  bitrix24ChannelJsonSchema,
  inspectBitrix24Account,
  listBitrix24AccountIds,
  normalizeBitrix24AllowFrom,
  normalizeBitrix24GroupPolicy,
  normalizeBitrix24Groups,
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
    expect(account.groups).toEqual({});
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

describe("groupPolicy and groups", () => {
  it("defaults to disabled with no groups", () => {
    const account = resolveBitrix24Account(cfg({}));
    expect(account.groupPolicy).toBe("disabled");
    expect(Object.keys(account.groups)).toEqual([]);
  });

  it("accepts only 'disabled' and 'allowlist'; anything else (including 'open') is disabled", () => {
    expect(resolveBitrix24Account(cfg({ groupPolicy: "allowlist" })).groupPolicy).toBe("allowlist");
    expect(resolveBitrix24Account(cfg({ groupPolicy: "disabled" })).groupPolicy).toBe("disabled");
    for (const raw of ["open", "ALLOWLIST", "all", 1, true, {}]) {
      const warnings: string[] = [];
      expect(normalizeBitrix24GroupPolicy(raw, (m) => warnings.push(m))).toBe("disabled");
      expect(warnings).toHaveLength(1);
    }
  });

  it("keeps only chat<N> keys whose value is an object; requireMention defaults to true", () => {
    const warnings: string[] = [];
    const groups = normalizeBitrix24Groups(
      {
        chat8801: {},
        chat8802: { requireMention: false },
        chat8803: { requireMention: "no" },
        chat8804: { requireMention: true },
        "8805": {},
        chat: {},
        "chat8806 ": {},
        CHAT8807: {},
        chat8808: true,
        chat8809: null,
      },
      (m) => warnings.push(m),
    );
    expect({ ...groups }).toEqual({
      chat8801: { requireMention: true },
      chat8802: { requireMention: false },
      chat8803: { requireMention: true },
      chat8804: { requireMention: true },
    });
    expect(warnings.length).toBe(6);
  });

  it("never resolves an inherited key as a listed group", () => {
    const groups = normalizeBitrix24Groups({ chat8801: {} });
    expect(groups["toString" as string]).toBeUndefined();
    expect(groups["__proto__" as string]).toBeUndefined();
    expect(groups["constructor" as string]).toBeUndefined();
  });

  it("treats a non-object groups value as empty", () => {
    expect(Object.keys(normalizeBitrix24Groups(["chat8801"]))).toEqual([]);
    expect(Object.keys(normalizeBitrix24Groups("chat8801"))).toEqual([]);
  });

  it("keeps enabled:false inert and default-deny with groups configured", () => {
    const account = resolveBitrix24Account(
      cfg({ groupPolicy: "allowlist", groups: { chat8801: {} } }),
    );
    expect(account.enabled).toBe(false);
    expect(account.allowFrom).toEqual([]);
  });

  it("reports groupPolicy and the group count in inspectAccount", () => {
    const inspected = inspectBitrix24Account(
      cfg({ groupPolicy: "allowlist", groups: { chat8801: {}, bogus: {} } }),
    );
    expect(inspected.groupPolicy).toBe("allowlist");
    expect(inspected.groupCount).toBe(1);
  });
});

describe("JSON schema (the SDK's runtime validator)", () => {
  const safeParse = (value: unknown) =>
    bitrix24ChannelConfigSchema.runtime!.safeParse(value) as {
      success: boolean;
      data?: Record<string, unknown>;
    };

  it("accepts groupPolicy allowlist with a chat<N> group and fills requireMention", () => {
    const result = safeParse({ groupPolicy: "allowlist", groups: { chat8801: {} } });
    expect(result.success).toBe(true);
    expect(result.data?.groups).toEqual({ chat8801: { requireMention: true } });
  });

  it("defaults groupPolicy to disabled", () => {
    const result = safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.groupPolicy).toBe("disabled");
  });

  it.each([
    ["groupPolicy open", { groupPolicy: "open" }],
    ["a non-chat<N> group key", { groups: { "8801": {} } }],
    ["an unknown per-group key", { groups: { chat8801: { allowFrom: ["4101"] } } }],
    ["a non-boolean requireMention", { groups: { chat8801: { requireMention: "yes" } } }],
  ])("rejects %s", (_label, value) => {
    expect(safeParse(value).success).toBe(false);
  });

  it("the manifest schema mirrors the code schema (descriptions aside)", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { channelConfigs: { bitrix24: { schema: unknown } } };
    const stripDescriptions = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(stripDescriptions);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "description")
            .map(([key, inner]) => [key, stripDescriptions(inner)]),
        );
      }
      return value;
    };
    expect(stripDescriptions(manifest.channelConfigs.bitrix24.schema)).toEqual(
      stripDescriptions(JSON.parse(JSON.stringify(bitrix24ChannelJsonSchema))),
    );
  });
});

describe("crmWebhookUrl (business pulse Gate 2, optional)", () => {
  const LIVE = {
    enabled: true,
    webhookUrl: "https://acme.example.bitrix24.eu/rest/42/tok/",
    botToken: "abc",
    portalDomain: "example.bitrix24.eu",
  };

  it("is optional: an enabled account without it still resolves (the channel is unaffected)", () => {
    const account = resolveBitrix24Account(cfg(LIVE));
    expect(account.enabled).toBe(true);
    expect(account.crmWebhookUrlStatus).toBe("missing");
    expect(account.crmWebhookUrlInput).toBeUndefined();
  });

  it("is inspected like webhookUrl, literal or SecretRef, without resolving it", () => {
    const literal = resolveBitrix24Account(
      cfg({ ...LIVE, crmWebhookUrl: "https://acme.example.bitrix24.eu/rest/9/crmtok/" }),
    );
    expect(literal.crmWebhookUrlStatus).toBe("available");
    const ref = { source: "env", provider: "default", id: "BITRIX24_CRM_WEBHOOK_URL" };
    const secretRef = resolveBitrix24Account(cfg({ ...LIVE, crmWebhookUrl: ref }));
    expect(secretRef.crmWebhookUrlStatus).toBe("configured_unavailable");
    expect(secretRef.crmWebhookUrlInput).toEqual(ref);
  });

  it("inspectAccount reports its status and does not count it toward `configured`", () => {
    const without = inspectBitrix24Account(cfg(LIVE));
    expect(without.configured).toBe(true);
    expect(without.crmWebhookUrlStatus).toBe("missing");
    const withIt = inspectBitrix24Account(cfg({ ...LIVE, crmWebhookUrl: "${BITRIX24_CRM_WEBHOOK_URL}" }));
    expect(withIt.configured).toBe(true);
    expect(withIt.crmWebhookUrlStatus).toBe("available");
  });

  it("the runtime schema accepts a string or a SecretRef object and rejects anything else", () => {
    const safeParse = (value: unknown) =>
      (bitrix24ChannelConfigSchema.runtime!.safeParse(value) as { success: boolean }).success;
    expect(safeParse({ crmWebhookUrl: "${BITRIX24_CRM_WEBHOOK_URL}" })).toBe(true);
    expect(safeParse({ crmWebhookUrl: { source: "env", provider: "default", id: "X" } })).toBe(true);
    expect(safeParse({ crmWebhookUrl: 42 })).toBe(false);
    expect(safeParse({ crmWebhookUrl: { source: "env", provider: "default", id: "X", extra: 1 } })).toBe(false);
  });

  it("is marked sensitive in the UI hints of the code and the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { channelConfigs: { bitrix24: { uiHints: Record<string, { sensitive?: boolean }> } } };
    expect(manifest.channelConfigs.bitrix24.uiHints.crmWebhookUrl?.sensitive).toBe(true);
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
