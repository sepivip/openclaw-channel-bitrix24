// Config surface for `channels.bitrix24`.
//
// Schema strategy (see README "Schema decision"): the OpenClaw 2026.9.4 image
// exports NO `openclaw/plugin-sdk/zod` subpath, and this plugin must ship with
// zero runtime dependencies (no `node_modules` next to the loaded artefact), so
// zod cannot be imported here. Instead we author plain JSON Schema and hand it
// to the SDK's `buildJsonChannelConfigSchema(...)`, which gives the same
// runtime validation/defaults contract as the zod path. Secret leaves use the
// SDK secret-input helpers.

import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { Bitrix24ConfigError } from "./secrets.js";

export const BITRIX24_CHANNEL_ID = "bitrix24";

export const DEFAULT_POLL_IDLE_MS = 15_000;
export const DEFAULT_POLL_ACTIVE_MS = 3_000;

/** No `"open"`. The pilot is default-deny (design §2.2). */
export const BITRIX24_DM_POLICIES = ["allowlist", "pairing", "disabled"] as const;
export type Bitrix24DmPolicy = (typeof BITRIX24_DM_POLICIES)[number];
export const BITRIX24_DEFAULT_DM_POLICY: Bitrix24DmPolicy = "allowlist";

/** Bitrix user ids are numeric strings. Telegram's `isNumericTelegramSenderUserId` pattern. */
const NUMERIC_ID_RE = /^\d+$/;

export const BITRIX24_DEFAULT_BOT = Object.freeze({
  code: "openclaw_bot",
  name: "Assistant",
  color: "PURPLE",
  workPosition: "AI Assistant",
});

/**
 * JSON Schema for `channels.bitrix24`. Mirrored verbatim into
 * `openclaw.plugin.json#channelConfigs.bitrix24.schema` so cold-path config,
 * setup and Control UI surfaces see the same shape before runtime loads.
 */
export const bitrix24ChannelJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      default: false,
      description: "Inert by default. Nothing starts until this is explicitly true.",
    },
    name: { type: "string", description: "Display name for this account." },
    webhookUrl: {
      description:
        "SecretInput. Bitrix24 inbound webhook base URL https://<portal>/rest/<userId>/<token>/ . Use ${BITRIX24_WEBHOOK_URL}.",
      anyOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "provider", "id"],
          properties: {
            source: { type: "string", enum: ["env", "file", "exec", "store"] },
            provider: { type: "string" },
            id: { type: "string" },
          },
        },
      ],
    },
    botToken: {
      description:
        "SecretInput. Caller-generated bot token (<=40 chars) required on every imbot.v2 call under webhook auth. Use ${BITRIX24_BOT_TOKEN}.",
      anyOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "provider", "id"],
          properties: {
            source: { type: "string", enum: ["env", "file", "exec", "store"] },
            provider: { type: "string" },
            id: { type: "string" },
          },
        },
      ],
    },
    portalDomain: {
      type: "string",
      description:
        "Portal domain the webhook host must end with, e.g. example.bitrix24.eu. Required for URL validation.",
    },
    dmPolicy: {
      type: "string",
      enum: [...BITRIX24_DM_POLICIES],
      default: BITRIX24_DEFAULT_DM_POLICY,
      description: "Default deny. There is deliberately no 'open' value for this channel.",
    },
    allowFrom: {
      type: "array",
      default: [],
      items: { type: "string", pattern: "^\\d+$" },
      description: "Numeric Bitrix24 user ids. Non-numeric entries are dropped with a warning.",
    },
    groupPolicy: {
      type: "string",
      enum: ["disabled"],
      default: "disabled",
      description: "Group chats are out of MVP scope.",
    },
    bot: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", default: BITRIX24_DEFAULT_BOT.code },
        name: { type: "string", default: BITRIX24_DEFAULT_BOT.name },
        color: { type: "string", default: BITRIX24_DEFAULT_BOT.color },
        workPosition: { type: "string", default: BITRIX24_DEFAULT_BOT.workPosition },
      },
    },
    poll: {
      type: "object",
      additionalProperties: false,
      properties: {
        idleMs: { type: "integer", minimum: 1000, default: DEFAULT_POLL_IDLE_MS },
        activeMs: { type: "integer", minimum: 500, default: DEFAULT_POLL_ACTIVE_MS },
      },
    },
    allowInsecureHttpForTests: {
      type: "boolean",
      default: false,
      description:
        "OFFLINE TESTS ONLY. Permits a plain http:// webhookUrl so a local fake-Bitrix stub can be driven without TLS. Honoured ONLY when NODE_ENV=test or BITRIX24_ALLOW_INSECURE_HTTP=1; inert on the pilot, which sets neither. Never set this in production.",
    },
  },
} as const;

/** Display-only hints. `sensitive: true` keeps secrets out of UI echoes. */
export const bitrix24ChannelUiHints = {
  webhookUrl: { label: "Inbound webhook URL", sensitive: true },
  botToken: { label: "Bot token", sensitive: true },
  portalDomain: { label: "Portal domain", placeholder: "example.bitrix24.eu" },
  allowFrom: { label: "Allowed Bitrix24 user ids" },
} as const;

/** Channel config schema handed to `ChannelPlugin.configSchema`. */
export const bitrix24ChannelConfigSchema = buildJsonChannelConfigSchema(
  bitrix24ChannelJsonSchema as unknown as Parameters<typeof buildJsonChannelConfigSchema>[0],
  {
    cacheKey: "openclaw-bitrix24-channel-config",
    uiHints: bitrix24ChannelUiHints as unknown as Record<string, { label?: string; placeholder?: string; sensitive?: boolean }>,
  } as Parameters<typeof buildJsonChannelConfigSchema>[1],
);

export type Bitrix24BotIdentity = {
  code: string;
  name: string;
  color: string;
  workPosition: string;
};

export type Bitrix24ChannelConfig = {
  enabled?: boolean;
  name?: string;
  webhookUrl?: unknown;
  botToken?: unknown;
  portalDomain?: string;
  dmPolicy?: Bitrix24DmPolicy;
  allowFrom?: unknown;
  groupPolicy?: "disabled";
  bot?: Partial<Bitrix24BotIdentity>;
  poll?: { idleMs?: number; activeMs?: number };
  allowInsecureHttpForTests?: boolean;
};

export type Bitrix24SecretStatus = "available" | "configured_unavailable" | "missing";

export type ResolvedBitrix24Account = {
  accountId: string;
  name: string;
  enabled: boolean;
  /**
   * Raw SecretInput as authored (literal string or SecretRef). Never logged.
   * `startAccount` resolves it asynchronously via the SDK runtime helper.
   */
  webhookUrlInput: unknown;
  botTokenInput: unknown;
  /** Sync inspection result. `"missing"` while enabled is fail-closed. */
  webhookUrlStatus: Bitrix24SecretStatus;
  botTokenStatus: Bitrix24SecretStatus;
  portalDomains: string[];
  dmPolicy: Bitrix24DmPolicy;
  allowFrom: string[];
  groupPolicy: "disabled";
  bot: Bitrix24BotIdentity;
  poll: { idleMs: number; activeMs: number };
  /** Test-only http escape hatch request; still gated on NODE_ENV/env marker. */
  allowInsecureHttpForTests: boolean;
  config: Bitrix24ChannelConfig;
};

function readSection(cfg: OpenClawConfig | undefined): Bitrix24ChannelConfig {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const section = channels?.[BITRIX24_CHANNEL_ID];
  return (section && typeof section === "object" ? section : {}) as Bitrix24ChannelConfig;
}

/**
 * Keep only numeric Bitrix user ids. Anything else is dropped with a warning
 * rather than silently accepted — `undefined ⇒ accept` is never allowed.
 */
export function normalizeBitrix24AllowFrom(
  raw: unknown,
  warn?: (message: string) => void,
): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    warn?.("[bitrix24] channels.bitrix24.allowFrom must be an array; ignoring it.");
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    const text = typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry.trim() : "";
    if (text && NUMERIC_ID_RE.test(text)) {
      out.push(text);
      continue;
    }
    warn?.(
      `[bitrix24] dropping non-numeric allowFrom entry (expected a Bitrix24 user id matching ^\\d+$).`,
    );
  }
  return out;
}

function normalizeDmPolicy(raw: unknown, warn?: (message: string) => void): Bitrix24DmPolicy {
  if (typeof raw !== "string" || raw.length === 0) {
    return BITRIX24_DEFAULT_DM_POLICY;
  }
  if ((BITRIX24_DM_POLICIES as readonly string[]).includes(raw)) {
    return raw as Bitrix24DmPolicy;
  }
  warn?.(
    `[bitrix24] unsupported dmPolicy "${raw}"; falling back to "${BITRIX24_DEFAULT_DM_POLICY}".`,
  );
  return BITRIX24_DEFAULT_DM_POLICY;
}

function inspectSecret(value: unknown, path: string): Bitrix24SecretStatus {
  if (value === undefined || value === null || value === "") {
    return "missing";
  }
  const resolution = resolveSecretInputString({ value, path, mode: "inspect" });
  return resolution.status;
}

/** Warn-once bookkeeping so config reads do not spam the log on every poll. */
const notedAccounts = new Set<string>();

function noteOnce(key: string, message: string): void {
  if (notedAccounts.has(key)) {
    return;
  }
  notedAccounts.add(key);
  console.log(message);
}

/** Test-only reset for the warn-once cache. */
export function resetBitrix24ConfigNotices(): void {
  notedAccounts.clear();
}

export function listBitrix24AccountIds(_cfg: OpenClawConfig): string[] {
  // Single-account MVP. Multi-account would add `accounts`/`defaultAccount`.
  return ["default"];
}

/**
 * Resolve `channels.bitrix24` into a typed account.
 *
 * FAIL-CLOSED: if the account is enabled and either secret is missing, this
 * throws `Bitrix24ConfigError` before any client, poller or network call can be
 * constructed. A disabled account resolves cleanly and starts nothing.
 */
export function resolveBitrix24Account(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedBitrix24Account {
  const id = (accountId ?? "default") || "default";
  const section = readSection(cfg);
  const warn = (message: string) => noteOnce(`${id}:${message}`, message);

  const enabled = section.enabled === true;
  const webhookUrlStatus = inspectSecret(section.webhookUrl, "channels.bitrix24.webhookUrl");
  const botTokenStatus = inspectSecret(section.botToken, "channels.bitrix24.botToken");

  if (enabled) {
    if (webhookUrlStatus === "missing") {
      throw new Bitrix24ConfigError(
        "channels.bitrix24 is enabled but webhookUrl is not configured. Refusing to start (fail-closed).",
        "channels.bitrix24.webhookUrl",
      );
    }
    if (botTokenStatus === "missing") {
      throw new Bitrix24ConfigError(
        "channels.bitrix24 is enabled but botToken is not configured. Refusing to start (fail-closed).",
        "channels.bitrix24.botToken",
      );
    }
  } else {
    noteOnce(
      `${id}:disabled`,
      `[bitrix24] account "${id}" is disabled (channels.bitrix24.enabled !== true); not started, no Bitrix24 calls will be made.`,
    );
  }

  const portalDomain = typeof section.portalDomain === "string" ? section.portalDomain.trim() : "";

  return {
    accountId: id,
    name: typeof section.name === "string" && section.name ? section.name : "Bitrix24",
    enabled,
    webhookUrlInput: section.webhookUrl,
    botTokenInput: section.botToken,
    webhookUrlStatus,
    botTokenStatus,
    portalDomains: portalDomain ? [portalDomain] : [],
    dmPolicy: normalizeDmPolicy(section.dmPolicy, warn),
    allowFrom: normalizeBitrix24AllowFrom(section.allowFrom, warn),
    groupPolicy: "disabled",
    bot: {
      code: section.bot?.code ?? BITRIX24_DEFAULT_BOT.code,
      name: section.bot?.name ?? BITRIX24_DEFAULT_BOT.name,
      color: section.bot?.color ?? BITRIX24_DEFAULT_BOT.color,
      workPosition: section.bot?.workPosition ?? BITRIX24_DEFAULT_BOT.workPosition,
    },
    poll: {
      idleMs: section.poll?.idleMs ?? DEFAULT_POLL_IDLE_MS,
      activeMs: section.poll?.activeMs ?? DEFAULT_POLL_ACTIVE_MS,
    },
    allowInsecureHttpForTests: section.allowInsecureHttpForTests === true,
    config: section,
  };
}

/**
 * Synchronous, secret-free diagnostics projection. Never throws, never resolves
 * a secret value — only its configured/unavailable/missing status.
 */
export function inspectBitrix24Account(
  cfg: OpenClawConfig,
  accountId?: string | null,
): {
  enabled: boolean;
  configured: boolean;
  webhookUrlStatus: Bitrix24SecretStatus;
  botTokenStatus: Bitrix24SecretStatus;
  portalDomainConfigured: boolean;
  dmPolicy: Bitrix24DmPolicy;
  allowFromCount: number;
  stateReason?: string;
} {
  const section = readSection(cfg);
  const enabled = section.enabled === true;
  const webhookUrlStatus = inspectSecret(section.webhookUrl, "channels.bitrix24.webhookUrl");
  const botTokenStatus = inspectSecret(section.botToken, "channels.bitrix24.botToken");
  const portalDomainConfigured =
    typeof section.portalDomain === "string" && section.portalDomain.trim().length > 0;
  const configured =
    webhookUrlStatus !== "missing" && botTokenStatus !== "missing" && portalDomainConfigured;
  if (!enabled) {
    void accountId;
  }
  return {
    enabled,
    configured,
    webhookUrlStatus,
    botTokenStatus,
    portalDomainConfigured,
    dmPolicy: normalizeDmPolicy(section.dmPolicy),
    allowFromCount: normalizeBitrix24AllowFrom(section.allowFrom).length,
    ...(enabled ? {} : { stateReason: "channels.bitrix24.enabled is not true" }),
  };
}
