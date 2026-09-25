// Agent tool `bitrix24_send_sheet`: post a server-built .xlsx into the CURRENT
// Bitrix24 chat.
//
// Security properties (every check REFUSES; none can widen what a turn may do):
//   * The target is never an argument. It comes ONLY from the trusted turn
//     context (`deliveryContext`, set by core from the inbound turn's reply
//     route), and must be a bitrix24 route with a numeric DM id or `chat<N>`.
//     Arguments are re-validated at runtime and any key beyond the four
//     declared ones (dialogId, chatId, to, target, ...) is refused.
//   * Only the agent the bitrix24 channel routes to may send, resolved from
//     the config's `bindings` (a `route` binding for channel "bitrix24" whose
//     accountId is "*", this account, or omitted for the default account). No
//     binding, or bindings naming more than one agent: refuse.
//   * Defence in depth against the live account config: a DM target must be
//     in `allowFrom`; a group target needs groupPolicy "allowlist" and a
//     `groups` entry; a known sender must be in `allowFrom`.
//   * Only a RUNNING account's client/botId/botToken is used.
//   * The rows and bytes never reach the model: the model gets the server's
//     summary, and the Bitrix caption is built from that summary only.
//   * Failure is `{ ok: false, error_code, message }` plus ONE warning line
//     with the code. Success is claimed only after Bitrix confirmed the upload.

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { Bitrix24Client } from "./client.js";
import {
  BITRIX24_CHANNEL_ID,
  listBitrix24AccountIds,
  resolveBitrix24Account,
  type ResolvedBitrix24Account,
} from "./config-schema.js";
import type { Bitrix24Log } from "./inbound.js";
import { sendFile } from "./outbound.js";
import { Bitrix24Error } from "./secrets.js";
import {
  fetchStockExport,
  isSheetExportError,
  isValidIsoDate,
  SHEETS_WAREHOUSE_CODE_RE,
  type SheetLang,
  type StockExportSummary,
} from "./sheets.js";

export const BITRIX24_SEND_SHEET_TOOL_NAME = "bitrix24_send_sheet";

/** The ONLY accepted argument keys. Note: no chat, dialog, user or target id. */
const ALLOWED_ARG_KEYS: ReadonlySet<string> = new Set(["kind", "warehouse_code", "as_of", "lang"]);

/** Argument names that try to pick a destination. Refused with their own code. */
const TARGET_ARG_KEYS: ReadonlySet<string> = new Set(
  [
    "dialogid",
    "dialog_id",
    "dialog",
    "chatid",
    "chat_id",
    "chat",
    "to",
    "target",
    "targetid",
    "target_id",
    "recipient",
    "userid",
    "user_id",
    "user",
    "channel",
    "accountid",
    "account_id",
    "threadid",
    "thread_id",
    "conversationid",
    "conversation_id",
    "peer",
  ],
);

const DM_TARGET_RE = /^\d{1,20}$/;
const GROUP_TARGET_RE = /^chat\d{1,20}$/;
const NUMERIC_ID_RE = /^\d{1,20}$/;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** JSON Schema handed to the model. Mirrors `validateSendSheetArgs`. */
export const bitrix24SendSheetParameters = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["stock"],
      description: "Which sheet to build. Only \"stock\" (stock balances from 1C) is available.",
    },
    warehouse_code: {
      type: "string",
      pattern: "^[A-Za-z0-9-]{1,32}$",
      description: "Optional warehouse code. Omit it for all warehouses.",
    },
    as_of: {
      type: "string",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
      description: "Optional date, YYYY-MM-DD. Omit it for the current balance.",
    },
    lang: {
      type: "string",
      enum: ["en", "ka"],
      description: "Language of the sheet headers and of the chat caption. Default en.",
    },
  },
} as const;

const TOOL_DESCRIPTION =
  "Send a stock sheet (.xlsx) built by the server from 1C into the CURRENT Bitrix24 chat. " +
  "The file always goes to the conversation you are answering; no other chat or user can be chosen. " +
  "The rows and totals are computed by the server and are not shown to you. " +
  "Quote the totals from the result exactly, never your own sums. " +
  "Say the file was sent only when the result has ok: true; otherwise say it was not sent.";

export type SendSheetArgs = {
  kind: "stock";
  warehouse_code?: string;
  as_of?: string;
  lang?: SheetLang;
};

export type SendSheetErrorCode =
  | "INVALID_ARGUMENTS"
  | "TARGET_NOT_ALLOWED"
  | "NOT_A_BITRIX_TURN"
  | "INVALID_TARGET"
  | "UNKNOWN_ACCOUNT"
  | "CONFIG_UNAVAILABLE"
  | "AGENT_NOT_RESOLVED"
  | "AGENT_NOT_ALLOWED"
  | "CHANNEL_UNAVAILABLE"
  | "DM_TARGET_NOT_ALLOWED"
  | "GROUP_TARGET_NOT_ALLOWED"
  | "SENDER_NOT_ALLOWED"
  | "ACCOUNT_NOT_RUNNING"
  | "UPLOAD_FAILED"
  | "ABORTED"
  | "INTERNAL_ERROR"
  | `EXPORT_${string}`;

export type SendSheetSuccess = {
  ok: true;
  file_name: string;
  rows: number;
  total_rows_available: number;
  total_quantity: string;
  total_quantity_all: string;
  as_of: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  truncated: boolean;
  message_id: string;
};

export type SendSheetFailure = {
  ok: false;
  error_code: SendSheetErrorCode;
  message: string;
};

export type SendSheetResult = SendSheetSuccess | SendSheetFailure;

class Refusal extends Error {
  readonly code: SendSheetErrorCode;
  constructor(code: SendSheetErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function refuse(code: SendSheetErrorCode, message: string): never {
  throw new Refusal(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runtime re-validation of the model's arguments. Core validates against the
 * JSON Schema first; this is the second, independent layer.
 */
export function validateSendSheetArgs(raw: unknown): SendSheetArgs {
  if (!isPlainObject(raw)) {
    refuse("INVALID_ARGUMENTS", "arguments must be an object with kind \"stock\"");
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => TARGET_ARG_KEYS.has(key.trim().toLowerCase()))) {
    refuse(
      "TARGET_NOT_ALLOWED",
      "the target chat cannot be chosen; the file always goes to the current conversation",
    );
  }
  if (keys.some((key) => !ALLOWED_ARG_KEYS.has(key))) {
    refuse("INVALID_ARGUMENTS", "only kind, warehouse_code, as_of and lang are accepted");
  }
  if (raw.kind !== "stock") {
    refuse("INVALID_ARGUMENTS", "kind must be \"stock\"");
  }
  const args: SendSheetArgs = { kind: "stock" };
  if (raw.warehouse_code !== undefined) {
    if (typeof raw.warehouse_code !== "string" || !SHEETS_WAREHOUSE_CODE_RE.test(raw.warehouse_code)) {
      refuse("INVALID_ARGUMENTS", "warehouse_code must be 1-32 letters, digits or hyphens");
    }
    args.warehouse_code = raw.warehouse_code;
  }
  if (raw.as_of !== undefined) {
    if (!isValidIsoDate(raw.as_of)) {
      refuse("INVALID_ARGUMENTS", "as_of must be a real date in YYYY-MM-DD form");
    }
    args.as_of = raw.as_of;
  }
  if (raw.lang !== undefined) {
    if (raw.lang !== "en" && raw.lang !== "ka") {
      refuse("INVALID_ARGUMENTS", "lang must be \"en\" or \"ka\"");
    }
    args.lang = raw.lang;
  }
  return args;
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export type Bitrix24RouteAgentResolution =
  | { ok: true; agentId: string }
  | { ok: false; reason: "no_binding" | "ambiguous" };

/**
 * The agent the bitrix24 channel routes to, from `cfg.bindings`.
 *
 * `AgentRouteBinding` (openclaw types.agents): `type` missing or "route";
 * `match.channel`; `match.accountId` "*" = every account, omitted/empty = the
 * channel's default account, otherwise that account id. Every matching route
 * binding counts, including peer-scoped ones; they must all name ONE agent.
 */
export function resolveBitrix24RouteAgentId(
  cfg: OpenClawConfig | undefined,
  accountId: string,
): Bitrix24RouteAgentResolution {
  const bindings = (cfg as { bindings?: unknown } | undefined)?.bindings;
  if (!Array.isArray(bindings)) {
    return { ok: false, reason: "no_binding" };
  }
  const account = normalizeId(accountId) || "default";
  const agents = new Set<string>();
  for (const binding of bindings) {
    if (!isPlainObject(binding)) {
      continue;
    }
    if (binding.type !== undefined && binding.type !== "route") {
      continue;
    }
    const match = binding.match;
    if (!isPlainObject(match) || normalizeId(match.channel) !== BITRIX24_CHANNEL_ID) {
      continue;
    }
    const bound = match.accountId;
    if (bound !== undefined && bound !== null && typeof bound !== "string") {
      continue;
    }
    const boundAccount = normalizeId(bound);
    let accountMatches: boolean;
    if (boundAccount === "*") {
      accountMatches = true;
    } else if (boundAccount === "") {
      // Omitted/empty: the channel's default account only.
      accountMatches = account === "default";
    } else {
      accountMatches = boundAccount === account;
    }
    if (!accountMatches) {
      continue;
    }
    // A matching binding without a usable agent id makes the route unknowable.
    agents.add(normalizeId(binding.agentId) || "<invalid>");
  }
  if (agents.size === 0) {
    return { ok: false, reason: "no_binding" };
  }
  const [only] = [...agents];
  if (agents.size > 1 || !only || only === "<invalid>") {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, agentId: only };
}

type TurnTarget = { dialogId: string; kind: "direct" | "group"; accountId: string };

function resolveTurnTarget(context: OpenClawPluginToolContext, cfg: OpenClawConfig): TurnTarget {
  const delivery = context.deliveryContext;
  if (!delivery || normalizeId(delivery.channel) !== BITRIX24_CHANNEL_ID) {
    refuse("NOT_A_BITRIX_TURN", "this tool only works while answering a Bitrix24 chat");
  }
  const to = typeof delivery.to === "string" ? delivery.to.trim() : "";
  let kind: TurnTarget["kind"];
  if (DM_TARGET_RE.test(to)) {
    kind = "direct";
  } else if (GROUP_TARGET_RE.test(to)) {
    kind = "group";
  } else {
    refuse("INVALID_TARGET", "the current conversation is not a Bitrix24 DM or group chat");
  }
  const fromDelivery = normalizeId(delivery.accountId);
  const fromContext = normalizeId(context.agentAccountId);
  if (fromDelivery && fromContext && fromDelivery !== fromContext) {
    refuse("UNKNOWN_ACCOUNT", "the current turn names two different Bitrix24 accounts");
  }
  const accountId = fromDelivery || fromContext || "default";
  if (!listBitrix24AccountIds(cfg).includes(accountId)) {
    refuse("UNKNOWN_ACCOUNT", "the current turn is not on a known Bitrix24 account");
  }
  return { dialogId: to, kind, accountId };
}

function assertAgentAllowed(context: OpenClawPluginToolContext, cfg: OpenClawConfig, accountId: string): void {
  const route = resolveBitrix24RouteAgentId(cfg, accountId);
  if (!route.ok) {
    refuse(
      "AGENT_NOT_RESOLVED",
      route.reason === "ambiguous"
        ? "the bitrix24 channel routes to more than one agent; refusing"
        : "no route binding for the bitrix24 channel; refusing",
    );
  }
  const agentId = normalizeId(context.agentId);
  if (!agentId || agentId !== route.agentId) {
    refuse("AGENT_NOT_ALLOWED", "only the agent bound to the bitrix24 channel may send files");
  }
}

function assertTargetAllowedByConfig(
  context: OpenClawPluginToolContext,
  cfg: OpenClawConfig,
  target: TurnTarget,
): void {
  let account: ResolvedBitrix24Account;
  try {
    account = resolveBitrix24Account(cfg, target.accountId);
  } catch {
    refuse("CHANNEL_UNAVAILABLE", "the Bitrix24 channel is not configured");
  }
  if (!account.enabled) {
    refuse("CHANNEL_UNAVAILABLE", "the Bitrix24 channel is disabled");
  }
  if (target.kind === "direct") {
    if (account.dmPolicy === "disabled" || !account.allowFrom.includes(target.dialogId)) {
      refuse("DM_TARGET_NOT_ALLOWED", "this DM is not on the Bitrix24 allowlist");
    }
  } else if (account.groupPolicy !== "allowlist" || !account.groups[target.dialogId]) {
    refuse("GROUP_TARGET_NOT_ALLOWED", "this group chat is not an approved Bitrix24 chat");
  }
  const sender = typeof context.requesterSenderId === "string" ? context.requesterSenderId.trim() : "";
  if (sender) {
    if (!NUMERIC_ID_RE.test(sender) || !account.allowFrom.includes(sender)) {
      refuse("SENDER_NOT_ALLOWED", "the requesting user is not on the Bitrix24 allowlist");
    }
    if (target.kind === "direct" && sender !== target.dialogId) {
      refuse("SENDER_NOT_ALLOWED", "the requesting user does not own this DM");
    }
  }
}

function readConfig(context: OpenClawPluginToolContext): OpenClawConfig {
  let cfg: OpenClawConfig | undefined;
  try {
    cfg = context.getRuntimeConfig?.();
  } catch {
    cfg = undefined;
  }
  cfg = cfg ?? context.runtimeConfig ?? context.config;
  if (!cfg || typeof cfg !== "object") {
    refuse("CONFIG_UNAVAILABLE", "no runtime config is available");
  }
  return cfg;
}

/** Georgian rendering of the server's `source` label, when it is the known one. */
function sourceLabel(source: string, lang: SheetLang): string {
  return lang === "ka" && source === "1C copy" ? "1C-ის ასლი" : source;
}

/**
 * The Bitrix caption, built ONLY from the server summary. Plain text; the
 * upload escapes BB-code brackets. Contains no em dash.
 */
export function buildStockSheetCaption(summary: StockExportSummary, lang: SheetLang = "en"): string {
  const code = summary.warehouse_code;
  const name = summary.warehouse_name;
  const source = sourceLabel(summary.source, lang);
  if (lang === "ka") {
    const where =
      code === null
        ? "ნაშთი ყველა საწყობში"
        : name
          ? `ნაშთი: ${name} (${code})`
          : `ნაშთი საწყობში ${code}`;
    let text =
      `${where}, ${summary.as_of}-ის მდგომარეობით: ${summary.rows} სტრიქონი, ` +
      `ჯამური რაოდენობა ${summary.total_quantity}. წყარო: ${source}.`;
    if (summary.truncated) {
      text +=
        ` შეკვეცილია: ნაჩვენებია ${summary.rows} სტრიქონი ${summary.total_rows_available}-დან.` +
        ` ყველა სტრიქონის ჯამური რაოდენობა: ${summary.total_quantity_all}.`;
    }
    return text;
  }
  const where =
    code === null
      ? "Stock across all warehouses"
      : name
        ? `Stock at ${name} (${code})`
        : `Stock at warehouse ${code}`;
  let text =
    `${where} as of ${summary.as_of}: ${summary.rows} lines, ` +
    `total quantity ${summary.total_quantity}. Source: ${source}.`;
  if (summary.truncated) {
    text +=
      ` Truncated: ${summary.rows} of ${summary.total_rows_available} lines shown.` +
      ` Total quantity of all lines: ${summary.total_quantity_all}.`;
  }
  return text;
}

export type Bitrix24AccountRuntimeHandle = {
  client: Bitrix24Client;
  botId: string;
  botToken: string;
};

export type Bitrix24SendSheetDeps = {
  /** Trusted tool context from the host (the factory argument). */
  context: OpenClawPluginToolContext;
  /** Running account lookup; `undefined` = not running. */
  getAccountRuntime: (accountId: string) => Bitrix24AccountRuntimeHandle | undefined;
  log?: Bitrix24Log;
  /** Injected for tests: the sidecar fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests: the environment holding the export token. */
  env?: NodeJS.ProcessEnv;
};

function logAt(log: Bitrix24Log | undefined, level: "info" | "warn", text: string): void {
  const sink = log?.[level] ?? log?.info;
  if (typeof sink === "function") {
    sink(text);
    return;
  }
  console.log(text);
}

function describeUploadFailure(error: unknown): string {
  if (error instanceof Bitrix24Error) {
    const code = SAFE_CODE_RE.test(error.code) ? error.code : "UNKNOWN";
    if (code === "TRANSPORT_ERROR") {
      return "Bitrix24 upload failed or timed out; the file was not confirmed as sent";
    }
    return `Bitrix24 upload failed (${code}); the file was not sent`;
  }
  return "Bitrix24 upload failed; the file was not sent";
}

/**
 * Run one `bitrix24_send_sheet` call. Never throws: every outcome is a
 * `SendSheetResult`. Logs exactly one line: info on success, warn on failure.
 */
export async function runBitrix24SendSheet(
  deps: Bitrix24SendSheetDeps,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<SendSheetResult> {
  try {
    const args = validateSendSheetArgs(rawArgs);
    const cfg = readConfig(deps.context);
    const target = resolveTurnTarget(deps.context, cfg);
    assertAgentAllowed(deps.context, cfg, target.accountId);
    assertTargetAllowedByConfig(deps.context, cfg, target);
    const runtime = deps.getAccountRuntime(target.accountId);
    if (!runtime) {
      refuse("ACCOUNT_NOT_RUNNING", "the Bitrix24 account is not running");
    }
    if (signal?.aborted) {
      refuse("ABORTED", "the request was cancelled");
    }

    const exported = await fetchStockExport({
      request: {
        ...(args.warehouse_code === undefined ? {} : { warehouse_code: args.warehouse_code }),
        ...(args.as_of === undefined ? {} : { as_of: args.as_of }),
        ...(args.lang === undefined ? {} : { lang: args.lang }),
      },
      ...(signal ? { signal } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.env ? { env: deps.env } : {}),
    });
    if (signal?.aborted) {
      refuse("ABORTED", "the request was cancelled; nothing was uploaded");
    }

    const summary = exported.summary;
    let uploaded: { fileId: string; messageId: string };
    try {
      uploaded = await sendFile({
        client: runtime.client,
        botId: runtime.botId,
        botToken: runtime.botToken,
        dialogId: target.dialogId,
        fileName: exported.fileName,
        contentBase64: exported.contentBase64,
        caption: buildStockSheetCaption(summary, args.lang ?? "en"),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      refuse("UPLOAD_FAILED", describeUploadFailure(error));
    }

    logAt(
      deps.log,
      "info",
      `[bitrix24] sheet sent kind=stock dialog=${target.dialogId} rows=${summary.rows} ` +
        `bytes=${exported.byteLength} file=${exported.fileName} messageId=${uploaded.messageId || "?"}`,
    );
    return {
      ok: true,
      file_name: exported.fileName,
      rows: summary.rows,
      total_rows_available: summary.total_rows_available,
      total_quantity: summary.total_quantity,
      total_quantity_all: summary.total_quantity_all,
      as_of: summary.as_of,
      warehouse_code: summary.warehouse_code,
      warehouse_name: summary.warehouse_name,
      truncated: summary.truncated,
      message_id: uploaded.messageId,
    };
  } catch (error) {
    let failure: SendSheetFailure;
    if (error instanceof Refusal) {
      failure = { ok: false, error_code: error.code, message: error.message };
    } else if (isSheetExportError(error)) {
      const upstream =
        error.upstreamCode && SAFE_CODE_RE.test(error.upstreamCode) ? ` (${error.upstreamCode})` : "";
      failure = {
        ok: false,
        error_code: error.code,
        message: `${error.message}${upstream}; the file was not sent`,
      };
    } else {
      failure = { ok: false, error_code: "INTERNAL_ERROR", message: "unexpected error; the file was not sent" };
    }
    logAt(deps.log, "warn", `[bitrix24] sheet not sent code=${failure.error_code}`);
    return failure;
  }
}

/**
 * Build the concrete tool for one run. Called by the host's tool factory with
 * the trusted context; cheap and side-effect free.
 */
export function createBitrix24SendSheetTool(deps: Bitrix24SendSheetDeps): AnyAgentTool {
  return {
    name: BITRIX24_SEND_SHEET_TOOL_NAME,
    label: "Send sheet to Bitrix24 chat",
    description: TOOL_DESCRIPTION,
    parameters: bitrix24SendSheetParameters as unknown as AnyAgentTool["parameters"],
    executionMode: "sequential",
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const result = await runBitrix24SendSheet(deps, params, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
