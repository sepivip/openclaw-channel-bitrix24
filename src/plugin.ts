// The Bitrix24 `ChannelPlugin` — live `imbot.v2` fetch-mode implementation.
//
// SAFETY GATES that remain (design §2.2):
//   1. `channels.bitrix24.enabled` must be true (default false). A disabled
//      account resolves cleanly and starts nothing.
//   2. Both `webhookUrl` and `botToken` must RESOLVE. A missing or unresolvable
//      secret makes `startAccount` throw BEFORE any client is constructed and
//      therefore before a single packet leaves the container.
//   3. `portalDomain` must be configured and the webhook host must sit under
//      it, or the URL is rejected at config load.
//
// There is NO inbound HTTP surface anywhere in this plugin: it registers no
// gateway HTTP route, opens no socket, binds no port. Fetch/poll only.

import {
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  BITRIX24_CHANNEL_ID,
  BITRIX24_DEFAULT_DM_POLICY,
  bitrix24ChannelConfigSchema,
  inspectBitrix24Account,
  listBitrix24AccountIds,
  resolveBitrix24Account,
  type ResolvedBitrix24Account,
} from "./config-schema.js";
import {
  createBitrix24Client,
  validateBitrix24BaseUrl,
  type Bitrix24Client,
} from "./client.js";
import { Bitrix24ConfigError, fingerprintSecret } from "./secrets.js";
import { createBitrix24EventHandler, describeError, type Bitrix24Log } from "./inbound.js";
import { createBitrix24Poller, type Bitrix24Poller } from "./poller.js";
import {
  BITRIX24_STATE_KEY_BOT_ID,
  createFileStateStore,
  type Bitrix24FileStateStore,
} from "./state-store.js";
import { sendText as sendBitrix24Text, sendTyping as sendBitrix24Typing } from "./outbound.js";

function logLine(
  log: Bitrix24Log | undefined,
  level: "info" | "warn" | "error" | "debug",
  text: string,
): void {
  const sink = log?.[level] ?? log?.info;
  if (typeof sink === "function") {
    sink(text);
    return;
  }
  console.log(text);
}

/** Resolve one SecretInput to a literal, or throw a config error. Fail-closed. */
async function requireSecret(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
  label: string;
}): Promise<string> {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: process.env,
    value: params.value,
    path: params.path,
  });
  const literal = typeof resolved.value === "string" ? resolved.value.trim() : "";
  if (!literal) {
    throw new Bitrix24ConfigError(
      `Bitrix24 ${params.label} is not configured or could not be resolved` +
        (resolved.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : "") +
        ". Refusing to start (fail-closed).",
      params.path,
    );
  }
  return literal;
}

type PreparedBitrix24Account = {
  webhookUrl: string;
  botToken: string;
  host: string;
  userId: string;
};

/**
 * Validate everything needed for a live account and return credentials.
 * Throws `Bitrix24ConfigError` BEFORE constructing a client or a request.
 */
async function prepareAccount(params: {
  cfg: OpenClawConfig;
  account: ResolvedBitrix24Account;
}): Promise<PreparedBitrix24Account> {
  const webhookUrl = await requireSecret({
    cfg: params.cfg,
    value: params.account.webhookUrlInput,
    path: "channels.bitrix24.webhookUrl",
    label: "webhookUrl",
  });
  const botToken = await requireSecret({
    cfg: params.cfg,
    value: params.account.botTokenInput,
    path: "channels.bitrix24.botToken",
    label: "botToken",
  });
  const validated = validateBitrix24BaseUrl({
    url: webhookUrl,
    portalDomains: params.account.portalDomains,
    allowInsecureHttpForTests: params.account.allowInsecureHttpForTests,
  });
  return { webhookUrl: validated.baseUrl, botToken, host: validated.host, userId: validated.userId };
}

function buildClient(params: {
  prepared: PreparedBitrix24Account;
  account: ResolvedBitrix24Account;
}): Bitrix24Client {
  return createBitrix24Client({
    baseUrl: params.prepared.webhookUrl,
    portalDomains: params.account.portalDomains,
    allowInsecureHttpForTests: params.account.allowInsecureHttpForTests,
  });
}

/**
 * `imbot.v2.Bot.register` — idempotent by `fields.code`.
 *
 * Request shape verified against
 * https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/imbot.v2/bots/bot-register.html
 *   fields.code        (required) "Unique code of the bot within the application"
 *   fields.properties  (required) { name (required), workPosition, color, … }
 *   fields.botToken    (<=40 chars) "Required for authorization via webhook"
 *   fields.eventMode   "fetch" | "webhook" (default "fetch")
 * Response: `result.bot.id`.
 * "The method is idempotent: a repeated call with the same `fields.code` from
 *  the same application returns the existing bot without updating the data."
 */
export async function registerBitrix24Bot(params: {
  client: Bitrix24Client;
  botToken: string;
  bot: ResolvedBitrix24Account["bot"];
  signal?: AbortSignal;
}): Promise<string> {
  const result = await params.client.call<unknown>(
    "imbot.v2.Bot.register",
    {
      fields: {
        code: params.bot.code,
        properties: {
          name: params.bot.name,
          workPosition: params.bot.workPosition,
          color: params.bot.color,
        },
        eventMode: "fetch",
        botToken: params.botToken,
      },
    },
    params.signal ? { signal: params.signal } : undefined,
  );
  const botId = extractBotId(result);
  if (!botId) {
    throw new Bitrix24ConfigError(
      "imbot.v2.Bot.register returned no bot id; refusing to start the poller.",
      "channels.bitrix24.bot.code",
    );
  }
  return botId;
}

/** `{ bot: { id } }` per apidocs; `{ id }` and a bare scalar tolerated. */
export function extractBotId(result: unknown): string {
  if (typeof result === "number" || (typeof result === "string" && result.length > 0)) {
    return String(result);
  }
  const record = (result ?? {}) as { bot?: { id?: unknown }; id?: unknown; botId?: unknown };
  const candidate = record.bot?.id ?? record.id ?? record.botId;
  return candidate === undefined || candidate === null ? "" : String(candidate);
}

type Bitrix24AccountRuntime = {
  accountId: string;
  client: Bitrix24Client;
  botToken: string;
  botId: string;
  poller: Bitrix24Poller;
  stateStore: Bitrix24FileStateStore;
  /** Long-lived account task; resolves only once the account is stopped. */
  lifecycle: Promise<void>;
  stop: () => Promise<void>;
};

/** Live accounts, keyed by accountId. Populated by `startAccount` only. */
const runningAccounts = new Map<string, Bitrix24AccountRuntime>();

/** Diagnostics/test accessor. Contains no credential material. */
export function inspectRunningBitrix24Account(
  accountId: string,
): { botId: string; poller: ReturnType<Bitrix24Poller["snapshot"]> } | undefined {
  const entry = runningAccounts.get(accountId);
  return entry ? { botId: entry.botId, poller: entry.poller.snapshot() } : undefined;
}

export const bitrix24Plugin = createChatChannelPlugin<ResolvedBitrix24Account>({
  base: {
    id: BITRIX24_CHANNEL_ID,
    meta: {
      id: BITRIX24_CHANNEL_ID,
      label: "Bitrix24",
      selectionLabel: "Bitrix24 (imbot.v2, fetch mode)",
      detailLabel: "Bitrix24 chat bot",
      docsPath: "/channels/bitrix24",
      blurb:
        "Polls imbot.v2.Event.get over an inbound webhook URL. No inbound HTTP surface, no port, no tunnel.",
      markdownCapable: false,
    },
    // "group" is a capability, not a permission: a group is only ever served
    // when groupPolicy is "allowlist" AND the chat is listed in `groups`
    // (inbound.ts), and it passes the hard guard (guard.ts).
    capabilities: { chatTypes: ["direct", "group"] },
    configSchema: bitrix24ChannelConfigSchema,
    config: {
      listAccountIds: listBitrix24AccountIds,
      resolveAccount: resolveBitrix24Account,
      inspectAccount: inspectBitrix24Account,
      isEnabled: (account) => account.enabled,
      disabledReason: () => "channels.bitrix24.enabled is not true",
    },
    gateway: {
      /**
       * Returns a LONG-LIVED promise, exactly like the bundled Telegram channel
       * (`/app/extensions/telegram/src/channel.ts:1017` returns the monitor
       * promise). The account lifecycle treats resolution as "the channel
       * exited" and schedules an auto-restart, so a `startAccount` that returns
       * immediately produces a restart loop. `runPassiveAccountLifecycle`
       * (openclaw/plugin-sdk/channel-outbound) is the SDK helper for exactly
       * this shape: it stays pending until the signal aborts, then runs `stop`.
       */
      async startAccount(ctx) {
        const account = ctx.account;
        const accountId = ctx.accountId || account.accountId || "default";
        const log = ctx.log as Bitrix24Log | undefined;

        if (!account.enabled) {
          logLine(
            log,
            "info",
            `[bitrix24] account "${accountId}" is disabled; not starting. No Bitrix24 call made.`,
          );
          return;
        }

        // Already running (hot-reload re-entry): hand back the SAME long-lived
        // promise rather than a resolved one, or the lifecycle restarts us.
        const existing = runningAccounts.get(accountId);
        if (existing) {
          logLine(log, "info", `[bitrix24] account "${accountId}" already running.`);
          return existing.lifecycle;
        }

        // FAIL-CLOSED. Throws before any client exists and before any network call.
        const prepared = await prepareAccount({ cfg: ctx.cfg, account });

        const setStatus = createAccountStatusSink({ accountId, setStatus: ctx.setStatus });

        logLine(
          log,
          "info",
          `[bitrix24] account "${accountId}" config validated ` +
            `host=${prepared.host} webhookUserId=${prepared.userId} ` +
            `webhookFp=${fingerprintSecret(prepared.webhookUrl)} ` +
            `botTokenFp=${fingerprintSecret(prepared.botToken)} ` +
            `dmPolicy=${account.dmPolicy} allowFrom=${account.allowFrom.length} ` +
            `groupPolicy=${account.groupPolicy} groups=${Object.keys(account.groups).length}`,
        );

        const client = buildClient({ prepared, account });
        const stateStore = createFileStateStore({
          accountId,
          onError: (message) => logLine(log, "warn", message),
        });

        // 1. Register the bot. Idempotent by `bot.code`, so a restart returns
        //    the SAME botId and no duplicate bot appears on the portal.
        const persisted = await stateStore.readAll();
        const botId = await registerBitrix24Bot({
          client,
          botToken: prepared.botToken,
          bot: account.bot,
          signal: ctx.abortSignal,
        });
        if (persisted[BITRIX24_STATE_KEY_BOT_ID] && persisted[BITRIX24_STATE_KEY_BOT_ID] !== botId) {
          logLine(
            log,
            "warn",
            `[bitrix24] botId changed (${persisted[BITRIX24_STATE_KEY_BOT_ID]} -> ${botId}); ` +
              `the portal bot for code "${account.bot.code}" was recreated.`,
          );
        }
        // 2. Persist it so outbound and typing work without a live poller.
        await stateStore.set(BITRIX24_STATE_KEY_BOT_ID, botId);
        logLine(
          log,
          "info",
          `[bitrix24] imbot.v2.Bot.register ok code=${account.bot.code} botId=${botId} eventMode=fetch`,
        );

        // 3. Our own controller, so `stopAccount` can end the account even when
        //    the host signal has not aborted.
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (ctx.abortSignal?.aborted) {
          controller.abort();
        } else {
          ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }

        const runtimeChannel = (ctx.channelRuntime ?? getBitrix24ChannelRuntime()) as
          | { reply?: { dispatchReplyFromConfig?: unknown } }
          | undefined;

        const onEvents = createBitrix24EventHandler({
          getConfig: () => ctx.cfg,
          getAccount: () => resolveBitrix24Account(ctx.cfg, accountId),
          accountId,
          client,
          getBotId: () => botId,
          botToken: prepared.botToken,
          ...(runtimeChannel?.reply?.dispatchReplyFromConfig
            ? { dispatchReplyFromConfig: runtimeChannel.reply.dispatchReplyFromConfig }
            : {}),
          ...(log ? { log } : {}),
          abortSignal: controller.signal,
        });

        const poller = createBitrix24Poller({
          client,
          accountId,
          botId,
          botToken: prepared.botToken,
          stateStore,
          idleMs: account.poll.idleMs,
          activeMs: account.poll.activeMs,
          onEvents,
          log: (message) => logLine(log, "warn", message),
          onDegraded: (reason) => {
            logLine(log, "warn", `[bitrix24] account "${accountId}" degraded: ${reason}`);
            try {
              setStatus({ statusState: "degraded", connected: false, stateReason: reason });
            } catch {
              /* status publication must never take the account down */
            }
          },
          onHealthy: () => {
            try {
              setStatus({ statusState: "ready", connected: true, lastError: null });
            } catch {
              /* ignore */
            }
          },
        });

        // 4. The long-lived task. Resolves only when the account is stopped.
        const lifecycle = runPassiveAccountLifecycle<Bitrix24Poller>({
          abortSignal: controller.signal,
          start: async () => {
            poller.start();
            try {
              setStatus({
                enabled: true,
                configured: true,
                running: true,
                connected: true,
                statusState: "ready",
                lastError: null,
              });
            } catch {
              /* ignore */
            }
            logLine(
              log,
              "info",
              `[bitrix24] polling imbot.v2.Event.get botId=${botId} ` +
                `activeMs=${account.poll.activeMs} idleMs=${account.poll.idleMs} ` +
                `(fetch mode, no listener)`,
            );
            return poller;
          },
          stop: async (handle) => {
            await handle.stop();
          },
          onStop: () => {
            ctx.abortSignal?.removeEventListener("abort", onAbort);
            runningAccounts.delete(accountId);
            try {
              setStatus({ running: false, connected: false, statusState: "stopped" });
            } catch {
              /* ignore */
            }
            logLine(log, "info", `[bitrix24] account "${accountId}" poller stopped.`);
          },
        });

        const stop = async () => {
          controller.abort();
          await lifecycle;
        };

        runningAccounts.set(accountId, {
          accountId,
          client,
          botToken: prepared.botToken,
          botId,
          poller,
          stateStore,
          lifecycle,
          stop,
        });

        return lifecycle;
      },
      async stopAccount(ctx) {
        const accountId = ctx.accountId || ctx.account?.accountId || "default";
        const log = ctx.log as Bitrix24Log | undefined;
        const entry = runningAccounts.get(accountId);
        if (!entry) {
          logLine(log, "info", `[bitrix24] account "${accountId}" was not running.`);
          return;
        }
        await entry.stop();
      },
    },
    heartbeat: {
      async sendTyping({ cfg, to, accountId }) {
        const id = accountId ?? "default";
        const outbound = await resolveOutboundContext(cfg as OpenClawConfig, id).catch(
          () => undefined,
        );
        if (!outbound) {
          return;
        }
        // Best effort. The v2 InputAction.notify param shape is not published in
        // apidocs (see README "Residual assumptions"), so a failure here must
        // never surface as a turn failure.
        try {
          await sendBitrix24Typing({
            client: outbound.client,
            botId: outbound.botId,
            botToken: outbound.botToken,
            dialogId: String(to),
          });
        } catch (error) {
          console.log(`[bitrix24] typing indicator failed (non-fatal) ${describeError(error)}`);
        }
      },
    },
  },
  security: {
    dm: {
      channelKey: BITRIX24_CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: BITRIX24_DEFAULT_DM_POLICY,
      // Bitrix user ids are numeric strings; keep the comparison form identical.
      normalizeEntry: (raw) => String(raw).trim(),
    },
  },
  pairing: {
    text: {
      idLabel: "bitrix24UserId",
      message: "Send this code to your administrator to approve this Bitrix24 account:",
      async notify(params) {
        // Called by core after `openclaw pairing approve bitrix24 <code>`.
        // `params.id` is the approved Bitrix user id; the DM target for a
        // Bitrix personal chat IS the user id (dialogId === userId).
        const accountId = params.accountId ?? "default";
        const outbound = await resolveOutboundContext(
          params.cfg as OpenClawConfig,
          accountId,
        ).catch(() => undefined);
        if (!outbound) {
          return;
        }
        try {
          await sendBitrix24Text({
            client: outbound.client,
            botId: outbound.botId,
            botToken: outbound.botToken,
            dialogId: String(params.id),
            text: params.message,
          });
        } catch (error) {
          console.log(`[bitrix24] pairing approval notice failed ${describeError(error)}`);
        }
      },
    },
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: BITRIX24_CHANNEL_ID,
      async sendText(ctx) {
        const accountId = ctx.accountId ?? "default";
        const outbound = await resolveOutboundContext(ctx.cfg as OpenClawConfig, accountId);
        const dialogId = String(ctx.to);
        const messageIds = await sendBitrix24Text({
          client: outbound.client,
          botId: outbound.botId,
          botToken: outbound.botToken,
          dialogId,
          text: String(ctx.text ?? ""),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return {
          messageId: messageIds[0] ?? "",
          target: { kind: "chat" as const, id: dialogId },
        };
      },
    },
  },
});

type Bitrix24OutboundContext = {
  client: Bitrix24Client;
  botId: string;
  botToken: string;
};

/**
 * Resolve the client + botId used by outbound sends.
 *
 * Prefers the live account started by `startAccount`. When no poller is running
 * (for example a message tool sending from a different process path), it
 * re-resolves the secrets fail-closed and recovers `botId` from persisted state
 * rather than guessing from `bot.code` — `Chat.Message.send` requires the
 * numeric id.
 */
async function resolveOutboundContext(
  cfg: OpenClawConfig,
  accountId: string,
): Promise<Bitrix24OutboundContext> {
  const running = runningAccounts.get(accountId);
  if (running) {
    return { client: running.client, botId: running.botId, botToken: running.botToken };
  }
  const account = resolveBitrix24Account(cfg, accountId);
  if (!account.enabled) {
    throw new Bitrix24ConfigError(
      "channels.bitrix24 is not enabled; refusing to send.",
      "channels.bitrix24.enabled",
    );
  }
  const prepared = await prepareAccount({ cfg, account });
  const stateStore = createFileStateStore({ accountId });
  const persisted = await stateStore.readAll();
  const botId = persisted[BITRIX24_STATE_KEY_BOT_ID] ?? "";
  if (!botId) {
    throw new Bitrix24ConfigError(
      "bitrix24 botId is unknown (imbot.v2.Bot.register has not run for this account yet).",
      "channels.bitrix24",
    );
  }
  return { client: buildClient({ prepared, account }), botId, botToken: prepared.botToken };
}

let pluginRuntime: unknown;

/** Stash the injected plugin runtime. Called by `defineChannelPluginEntry`. */
export function setBitrix24Runtime(runtime: unknown): void {
  pluginRuntime = runtime;
}

/** Accessor for the injected runtime. */
export function getBitrix24Runtime(): unknown {
  return pluginRuntime;
}

/** `PluginRuntime["channel"]` when the Gateway injected one. */
function getBitrix24ChannelRuntime(): unknown {
  return (pluginRuntime as { channel?: unknown } | undefined)?.channel;
}
