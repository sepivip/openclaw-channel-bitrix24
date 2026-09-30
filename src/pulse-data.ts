// Agent tool `bitrix24_pulse_data`: READ-ONLY "Customer calls" summary for a
// business-pulse skill. Built for a portal whose CRM deals are logged phone
// calls (one pipeline; in-progress stages, one won stage, and failure stages
// that are really call TOPICS), with no amounts. Tasks and calendars are out
// of scope.
//
// Properties:
//   * Only the agent bound to the bitrix24 channel (config `bindings`) may
//     call it: the host-set `context.agentId` must equal that agent. Anything
//     else is NOT_BITRIX_AGENT before any Bitrix request.
//   * Reads only, through the separate CRM client (src/crm-client.ts) and its
//     three-method allowlist. The only argument is `sections` (`calls`): no
//     argument can name a method, a URL, a filter, a user or a chat.
//   * Counts only. It selects deal id, pipeline, stage and two timestamps;
//     never a title, an amount, a person or a contact, and returns none.
//   * Rolling whole-day windows in Asia/Tbilisi (+04:00, no DST), like the
//     RS.GE part: "last 7 days" = today-6 .. today, "the 7 before" =
//     today-13 .. today-7.
//   * No pipeline visible means no CRM read access (Bitrix answers empty
//     lists, not errors, to a user without rights; every portal has the
//     default pipeline): the section is unavailable with NO_CRM_ACCESS rather
//     than reporting zero calls.
//   * Per-section isolation: a failing section is left out of `sections` and
//     listed in `unavailable` with a fixed code and a fixed, content-free
//     message. The call fails when every requested section failed.
//   * Never logs or returns the webhook URL, its token, or Bitrix error text.
//     One log line per call (sections, codes, counts, timing, fingerprint).

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { validateBitrix24BaseUrl } from "./client.js";
import { resolveBitrix24Account, type ResolvedBitrix24Account } from "./config-schema.js";
import {
  BITRIX24_CRM_MAX_PAGES,
  BITRIX24_CRM_PAGE_SIZE,
  createBitrix24CrmClient,
  type Bitrix24CrmCallOptions,
  type Bitrix24CrmClient,
} from "./crm-client.js";
import type { Bitrix24Log } from "./inbound.js";
import { Bitrix24Error, fingerprintSecret } from "./secrets.js";
import { resolveBitrix24RouteAgentId } from "./tools.js";

export const BITRIX24_PULSE_DATA_TOOL_NAME = "bitrix24_pulse_data";

export const PULSE_SECTIONS = ["calls"] as const;
export type PulseSection = (typeof PULSE_SECTIONS)[number];

export const PULSE_TIMEZONE = "Asia/Tbilisi";
export const PULSE_WINDOW_DAYS = 7;
/** A call waiting longer than this is counted in `waiting_over_2_days`. */
export const PULSE_WAITING_ALERT_MS = 2 * 86_400_000;

/** Asia/Tbilisi is UTC+4 all year (no DST since 2005). */
const TBILISI_OFFSET_MS = 4 * 60 * 60 * 1000;
const TBILISI_OFFSET_TEXT = "+04:00";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** CRM entity type of a deal. */
const DEAL_ENTITY_TYPE_ID = 2;
const TEXT_MAX = 200;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** C0 controls, DEL and C1 controls. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Deal fields ever read. No title, amount, assignee, contact or source. */
const CLOSED_CALL_SELECT = Object.freeze(["id", "categoryId", "stageId", "createdTime", "movedTime"]);
const WAITING_CALL_SELECT = Object.freeze(["id", "stageId", "createdTime"]);
const COUNT_SELECT = Object.freeze(["id"]);

/** JSON Schema handed to the model. Mirrors `validatePulseDataArgs`. */
export const bitrix24PulseDataParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    sections: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: [...PULSE_SECTIONS] },
      description: "Which parts to read. Omit it: the only part is calls.",
    },
  },
} as const;

const TOOL_DESCRIPTION =
  "Read-only summary of customer calls from the Bitrix24 CRM (each call is a CRM deal) for the business " +
  "pulse: calls created and closed in the last 7 days against the 7 before, calls waiting now and how long " +
  "the oldest has waited, the median hours to close, and the call topics (the stages calls were closed in) " +
  "of the last 7 days. Counts only: no names, amounts or call details. Quote every figure exactly. " +
  "If the section is listed in unavailable, say so with its code and never guess its figures; NO_CRM_ACCESS " +
  "means the service user cannot read CRM deals. This tool cannot change anything in Bitrix24. Only the " +
  "Bitrix24 assistant agent may call it.";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type CallsData = {
  window: { from: string; to: string };
  prior_window: { from: string; to: string };
  created: { last_7_days: number; prior_7_days: number };
  closed: { last_7_days: number; prior_7_days: number };
  waiting_now: number;
  oldest_waiting_days: number | null;
  waiting_over_2_days: number;
  median_hours_to_close_last_7_days: number | null;
  topics_last_7_days: Array<{ stage: string; semantics: "S" | "F"; count: number }>;
  pipelines: Array<{ id: number; name: string | null; closed_last_7_days: number }>;
};

export type PulseUnavailable = { section: PulseSection; code: string; message: string };

export type PulseDataMeta = {
  sections_requested: PulseSection[];
  elapsed_ms: Partial<Record<PulseSection, number>> & { total: number };
  requests: Partial<Record<PulseSection, number>> & { total: number };
  truncated: Partial<Record<PulseSection, boolean>>;
  page_size: number;
  page_cap: number;
};

export type PulseDataSuccess = {
  ok: true;
  as_of: string;
  generated_at: string;
  timezone: typeof PULSE_TIMEZONE;
  sections: { calls?: CallsData };
  unavailable: PulseUnavailable[];
  meta: PulseDataMeta;
};

export type PulseDataErrorCode =
  | "INVALID_ARGUMENTS"
  | "NOT_BITRIX_AGENT"
  | "NOT_CONFIGURED"
  | "ALL_SECTIONS_UNAVAILABLE"
  | "ABORTED"
  | "INTERNAL_ERROR";

export type PulseDataFailure = {
  ok: false;
  error_code: PulseDataErrorCode;
  message: string;
  unavailable?: PulseUnavailable[];
};

export type PulseDataResult = PulseDataSuccess | PulseDataFailure;

class PulseRefusal extends Error {
  readonly code: PulseDataErrorCode;
  constructor(code: PulseDataErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function refuse(code: PulseDataErrorCode, message: string): never {
  throw new PulseRefusal(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Runtime re-validation of the model's arguments (core validates the schema first). */
export function validatePulseDataArgs(raw: unknown): { sections: PulseSection[] } {
  const all = { sections: [...PULSE_SECTIONS] };
  if (raw === undefined || raw === null) {
    return all;
  }
  if (!isPlainObject(raw)) {
    refuse("INVALID_ARGUMENTS", "arguments must be an object with an optional sections list");
  }
  if (Object.keys(raw).some((key) => key !== "sections")) {
    refuse("INVALID_ARGUMENTS", "only sections is accepted");
  }
  if (raw.sections === undefined) {
    return all;
  }
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    refuse("INVALID_ARGUMENTS", "sections must be a non-empty list; the only section is calls");
  }
  const wanted = new Set<string>();
  for (const entry of raw.sections) {
    if (typeof entry !== "string" || !(PULSE_SECTIONS as readonly string[]).includes(entry)) {
      refuse("INVALID_ARGUMENTS", "unknown section; the only section is calls");
    }
    wanted.add(entry);
  }
  return { sections: PULSE_SECTIONS.filter((section) => wanted.has(section)) };
}

// ---------------------------------------------------------------------------
// Time (Asia/Tbilisi, fixed +04:00)
// ---------------------------------------------------------------------------

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function tbilisiShifted(ms: number): string {
  return new Date(ms + TBILISI_OFFSET_MS).toISOString();
}

/** `YYYY-MM-DD` of an instant, in Tbilisi. */
export function tbilisiDate(ms: number): string {
  return tbilisiShifted(ms).slice(0, 10);
}

/** ISO 8601 with the Tbilisi offset, e.g. `2026-09-23T00:00:00+04:00`. */
export function tbilisiIso(ms: number): string {
  return `${tbilisiShifted(ms).slice(0, 19)}${TBILISI_OFFSET_TEXT}`;
}

/** The instant a Tbilisi calendar day starts. */
function dayStartMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - TBILISI_OFFSET_MS;
}

function addDays(date: string, days: number): string {
  return tbilisiDate(dayStartMs(date) + days * DAY_MS);
}

const ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse a Bitrix REST datetime (ISO 8601, e.g. `2026-09-22T21:30:00+01:00`).
 * A value without an offset is taken as Tbilisi wall time. Anything else:
 * `undefined` (the caller decides; nothing is guessed).
 */
export function parseBitrixDateTime(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const m = ISO_DATETIME_RE.exec(value.trim());
  if (!m) {
    return undefined;
  }
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (!isRealDate(y, mo, d) || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  let offsetMs = TBILISI_OFFSET_MS;
  const zone = m[7];
  if (zone === "Z") {
    offsetMs = 0;
  } else if (zone) {
    const digits = zone.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    offsetMs = (zone.startsWith("-") ? -1 : 1) * minutes * 60_000;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMs;
}

export type PulseWindows = {
  nowMs: number;
  today: string;
  /** today-6: first day of "the last 7 days". */
  windowFrom: string;
  windowStartMs: number;
  /** today-13 .. today-7: "the 7 before". */
  priorFrom: string;
  priorTo: string;
  priorStartMs: number;
};

export function buildPulseWindows(nowMs: number): PulseWindows {
  const today = tbilisiDate(nowMs);
  const windowFrom = addDays(today, -(PULSE_WINDOW_DAYS - 1));
  const priorFrom = addDays(today, -(2 * PULSE_WINDOW_DAYS - 1));
  return {
    nowMs,
    today,
    windowFrom,
    windowStartMs: dayStartMs(windowFrom),
    priorFrom,
    priorTo: addDays(today, -PULSE_WINDOW_DAYS),
    priorStartMs: dayStartMs(priorFrom),
  };
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function cleanText(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function readInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^-?\d{1,15}$/.test(value.trim()) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function invalidResponse(method: string): Bitrix24Error {
  return new Bitrix24Error({
    method,
    code: "INVALID_RESPONSE",
    description: "Bitrix24 answered in an unexpected shape",
  });
}

function rowsOf(key: string): (result: unknown) => unknown[] | undefined {
  return (result) => (isPlainObject(result) && Array.isArray(result[key]) ? (result[key] as unknown[]) : undefined);
}

const arrayResult = (result: unknown): unknown[] | undefined => (Array.isArray(result) ? result : undefined);
const dealRows = rowsOf("items");

/**
 * A deal stage's semantics: `S` (success), `F` (failure; on a call-log portal
 * these are call topics) or `P` (in progress). The real portal sends the string
 * "process" for in-progress stages; the docs show null. Both, an empty value
 * and anything unknown are in progress; `EXTRA.SEMANTICS` is read only when
 * the top-level value is empty.
 */
export function stageSemantics(row: Record<string, unknown>): "P" | "S" | "F" {
  const read = (value: unknown): "P" | "S" | "F" | undefined => {
    const text = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (text === "S" || text === "SUCCESS") {
      return "S";
    }
    if (text === "F" || text === "FAILURE") {
      return "F";
    }
    if (text === "P" || text === "PROCESS") {
      return "P";
    }
    return undefined;
  };
  const top = read(row.SEMANTICS);
  if (top) {
    return top;
  }
  const extra = isPlainObject(row.EXTRA) ? read(row.EXTRA.SEMANTICS) : undefined;
  return extra ?? "P";
}

// ---------------------------------------------------------------------------
// Section: calls
// ---------------------------------------------------------------------------

type Pipeline = { id: number; name: string | null; sort: number };
type Stage = { id: string; name: string | null; sort: number; semantics: "P" | "S" | "F"; pipelineIndex: number };

type SectionRun = {
  client: Bitrix24CrmClient;
  windows: PulseWindows;
  call: Bitrix24CrmCallOptions;
};

type SectionOutput<T> = { data: T; truncated: boolean };

function readPipelines(rows: unknown[]): Pipeline[] {
  const out: Pipeline[] = [];
  for (const row of rows) {
    if (!isPlainObject(row)) {
      continue;
    }
    const id = readInt(row.id);
    if (id === undefined || id < 0 || out.some((p) => p.id === id)) {
      continue;
    }
    out.push({ id, name: cleanText(row.name), sort: readInt(row.sort) ?? 0 });
  }
  return out.sort((a, b) => a.sort - b.sort || a.id - b.id);
}

function readStages(rows: unknown[], pipelineIndex: number): Stage[] {
  const out: Stage[] = [];
  for (const row of rows) {
    if (!isPlainObject(row) || typeof row.STATUS_ID !== "string" || !row.STATUS_ID) {
      continue;
    }
    out.push({
      id: row.STATUS_ID,
      name: cleanText(row.NAME),
      sort: readInt(row.SORT) ?? 0,
      semantics: stageSemantics(row),
      pipelineIndex,
    });
  }
  return out;
}

/** The median of `values` (not empty), rounded to one decimal. */
function medianOneDecimal(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(median * 10) / 10;
}

async function readCalls(run: SectionRun): Promise<SectionOutput<CallsData>> {
  const { client, windows, call } = run;
  const windowStart = tbilisiIso(windows.windowStartMs);
  const priorStart = tbilisiIso(windows.priorStartMs);

  // 1. Pipelines first: none visible means no read access, and no deal is read.
  const listedPipelines = await client.list(
    "crm.category.list",
    { entityTypeId: DEAL_ENTITY_TYPE_ID },
    rowsOf("categories"),
    call,
  );
  const pipelines = readPipelines(listedPipelines.items);
  if (pipelines.length === 0) {
    throw new Bitrix24Error({
      method: "crm.category.list",
      code: "NO_CRM_ACCESS",
      description: "no deal pipeline is visible to the service user",
    });
  }

  /** A count from the list `total` (one cheap page of ids). */
  const countDeals = async (filter: Record<string, unknown>) => {
    const page = await client.call(
      "crm.item.list",
      { entityTypeId: DEAL_ENTITY_TYPE_ID, select: [...COUNT_SELECT], filter, start: 0 },
      call,
    );
    const rows = dealRows(page.result);
    if (!rows) {
      throw invalidResponse("crm.item.list");
    }
    return { count: page.total ?? rows.length, truncated: page.total === undefined && page.next !== undefined };
  };
  const closedSince = (semantics: "S" | "F") =>
    client.list(
      "crm.item.list",
      {
        entityTypeId: DEAL_ENTITY_TYPE_ID,
        select: [...CLOSED_CALL_SELECT],
        filter: { stageSemanticId: semantics, ">=movedTime": windowStart },
        order: { id: "ASC" },
      },
      dealRows,
      call,
    );

  // 2. Everything else in parallel (the client's throttle still spaces them).
  const [stageLists, createdNow, createdPrior, wonNow, topicNow, wonPrior, topicPrior, waiting] = await Promise.all([
    Promise.all(
      pipelines.map((p) =>
        client.list(
          "crm.status.list",
          { filter: { ENTITY_ID: p.id === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${p.id}` }, order: { SORT: "ASC" } },
          arrayResult,
          call,
        ),
      ),
    ),
    countDeals({ ">=createdTime": windowStart }),
    countDeals({ ">=createdTime": priorStart, "<createdTime": windowStart }),
    closedSince("S"),
    closedSince("F"),
    countDeals({ stageSemanticId: "S", ">=movedTime": priorStart, "<movedTime": windowStart }),
    countDeals({ stageSemanticId: "F", ">=movedTime": priorStart, "<movedTime": windowStart }),
    client.call(
      "crm.item.list",
      {
        entityTypeId: DEAL_ENTITY_TYPE_ID,
        select: [...WAITING_CALL_SELECT],
        filter: { stageSemanticId: "P" },
        order: { createdTime: "ASC" },
        start: 0,
      },
      call,
    ),
  ]);

  const stageById = new Map<string, Stage>();
  stageLists.forEach((listed, index) => {
    for (const stage of readStages(listed.items, index)) {
      stageById.set(stage.id, stage);
    }
  });
  const pipelineIndex = new Map(pipelines.map((p, index) => [p.id, index]));

  // Closed in the last 7 days: re-check the window on movedTime and, for a
  // known stage, that its semantics match the query (a contradiction is left
  // out). An unreadable time is left to Bitrix's own filter.
  type ClosedCall = { categoryId: number; stageId: string; semantics: "S" | "F"; hours: number | undefined };
  const closed = new Map<number, ClosedCall>();
  for (const [semantics, listed] of [
    ["S", wonNow],
    ["F", topicNow],
  ] as const) {
    for (const row of listed.items) {
      if (!isPlainObject(row)) {
        continue;
      }
      const id = readInt(row.id);
      if (id === undefined || closed.has(id)) {
        continue;
      }
      const moved = parseBitrixDateTime(row.movedTime);
      if (moved !== undefined && moved < windows.windowStartMs) {
        continue;
      }
      const stageId = typeof row.stageId === "string" ? row.stageId : "";
      const known = stageById.get(stageId);
      if (known && known.semantics !== semantics) {
        continue;
      }
      const created = parseBitrixDateTime(row.createdTime);
      closed.set(id, {
        categoryId: readInt(row.categoryId) ?? 0,
        stageId,
        semantics,
        hours: moved !== undefined && created !== undefined ? Math.max(0, moved - created) / HOUR_MS : undefined,
      });
    }
  }

  // Topics: closed calls by stage, most first; ties in pipeline and stage order.
  const topicCounts = new Map<string, { semantics: "S" | "F"; count: number }>();
  const closedByPipeline = new Map<number, number>();
  for (const c of closed.values()) {
    const entry = topicCounts.get(c.stageId) ?? { semantics: c.semantics, count: 0 };
    entry.count += 1;
    topicCounts.set(c.stageId, entry);
    closedByPipeline.set(c.categoryId, (closedByPipeline.get(c.categoryId) ?? 0) + 1);
  }
  const unknownRank = Number.MAX_SAFE_INTEGER;
  const topics = [...topicCounts.entries()]
    .map(([stageId, t]) => ({ stageId, ...t, stage: stageById.get(stageId) }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.stage?.pipelineIndex ?? unknownRank) - (b.stage?.pipelineIndex ?? unknownRank) ||
        (a.stage?.sort ?? unknownRank) - (b.stage?.sort ?? unknownRank) ||
        a.stageId.localeCompare(b.stageId),
    )
    .map((t) => ({ stage: t.stage?.name ?? t.stageId, semantics: t.semantics, count: t.count }));

  const hours = [...closed.values()].map((c) => c.hours).filter((h): h is number => h !== undefined);

  // Waiting now: the count is Bitrix's total; the oldest comes from the first
  // page (ordered by createdTime), re-checked to be an in-progress stage.
  const waitingRows = dealRows(waiting.result);
  if (!waitingRows) {
    throw invalidResponse("crm.item.list");
  }
  const waitingCreated = waitingRows
    .filter(isPlainObject)
    .filter((row) => {
      const known = stageById.get(typeof row.stageId === "string" ? row.stageId : "");
      return !known || known.semantics === "P";
    })
    .map((row) => parseBitrixDateTime(row.createdTime))
    .filter((ms): ms is number => ms !== undefined);
  const waitingNow = waiting.total ?? waitingRows.length;
  const oldest = waitingCreated.length > 0 ? Math.min(...waitingCreated) : undefined;
  const alertBeforeMs = windows.nowMs - PULSE_WAITING_ALERT_MS;
  let waitingOver2Days: number;
  let waitingTruncated = false;
  if (waiting.next === undefined) {
    waitingOver2Days = waitingCreated.filter((ms) => ms < alertBeforeMs).length;
  } else {
    // More than one page waiting: count the old ones with their own query.
    const old = await countDeals({ stageSemanticId: "P", "<createdTime": tbilisiIso(alertBeforeMs) });
    waitingOver2Days = old.count;
    waitingTruncated = old.truncated || waiting.total === undefined;
  }

  const unknownPipelines = [...closedByPipeline.keys()].filter((id) => !pipelineIndex.has(id)).sort((a, b) => a - b);

  return {
    data: {
      window: { from: windows.windowFrom, to: windows.today },
      prior_window: { from: windows.priorFrom, to: windows.priorTo },
      created: { last_7_days: createdNow.count, prior_7_days: createdPrior.count },
      closed: { last_7_days: closed.size, prior_7_days: wonPrior.count + topicPrior.count },
      waiting_now: waitingNow,
      oldest_waiting_days:
        waitingNow > 0 && oldest !== undefined ? Math.max(0, Math.floor((windows.nowMs - oldest) / DAY_MS)) : null,
      waiting_over_2_days: waitingOver2Days,
      median_hours_to_close_last_7_days: hours.length > 0 ? medianOneDecimal(hours) : null,
      topics_last_7_days: topics,
      pipelines: [
        ...pipelines.map((p) => ({ id: p.id, name: p.name, closed_last_7_days: closedByPipeline.get(p.id) ?? 0 })),
        ...unknownPipelines.map((id) => ({ id, name: null, closed_last_7_days: closedByPipeline.get(id) ?? 0 })),
      ],
    },
    truncated:
      listedPipelines.truncated ||
      stageLists.some((l) => l.truncated) ||
      createdNow.truncated ||
      createdPrior.truncated ||
      wonNow.truncated ||
      topicNow.truncated ||
      wonPrior.truncated ||
      topicPrior.truncated ||
      waitingTruncated,
  };
}

// ---------------------------------------------------------------------------
// Config, caller and the webhook
// ---------------------------------------------------------------------------

function readConfig(context: OpenClawPluginToolContext): OpenClawConfig {
  let cfg: OpenClawConfig | undefined;
  try {
    cfg = context.getRuntimeConfig?.();
  } catch {
    cfg = undefined;
  }
  cfg = cfg ?? context.runtimeConfig ?? context.config;
  if (!cfg || typeof cfg !== "object") {
    refuse("NOT_CONFIGURED", "no runtime config is available");
  }
  return cfg;
}

/**
 * Only the agent the bitrix24 channel routes to may read pulse data. The
 * caller is the host-set `context.agentId` of the tool factory (never an
 * argument), compared the way `bitrix24_send_sheet` compares it. No Bitrix
 * `deliveryContext` or sender is required, so a direct turn of that agent
 * works; another agent, or a call without an agent id (an operator
 * `/tools/invoke`), is refused before any Bitrix request.
 */
function assertBitrixAgent(context: OpenClawPluginToolContext, cfg: OpenClawConfig): void {
  const agentId = typeof context.agentId === "string" ? context.agentId.trim().toLowerCase() : "";
  if (!agentId) {
    refuse("NOT_BITRIX_AGENT", "no calling agent; only the agent bound to the bitrix24 channel may read pulse data");
  }
  // The pulse reads the single (default) account's CRM webhook.
  const route = resolveBitrix24RouteAgentId(cfg, "default");
  if (!route.ok) {
    refuse(
      "NOT_BITRIX_AGENT",
      route.reason === "ambiguous"
        ? "the bitrix24 channel routes to more than one agent; refusing"
        : "no route binding for the bitrix24 channel; refusing",
    );
  }
  if (agentId !== route.agentId) {
    refuse("NOT_BITRIX_AGENT", "only the agent bound to the bitrix24 channel may read pulse data");
  }
}

type CrmTarget = {
  baseUrl: string;
  portalDomains: string[];
  allowInsecureHttpForTests: boolean;
  fingerprint: string;
};

/**
 * Resolve `channels.bitrix24.crmWebhookUrl`. Every failure is NOT_CONFIGURED
 * with a fixed message: never the URL, the host or the resolver's reason.
 * The channel's own `enabled` gate applies: a disabled channel makes no call.
 */
async function resolveCrmTarget(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): Promise<CrmTarget> {
  let account: ResolvedBitrix24Account;
  try {
    account = resolveBitrix24Account(cfg, "default");
  } catch {
    refuse("NOT_CONFIGURED", "the Bitrix24 channel is not configured");
  }
  if (!account.enabled) {
    refuse("NOT_CONFIGURED", "the Bitrix24 channel is disabled");
  }
  if (account.crmWebhookUrlStatus === "missing") {
    refuse("NOT_CONFIGURED", "no read-only CRM webhook is configured (channels.bitrix24.crmWebhookUrl)");
  }
  let literal = "";
  try {
    const resolved = await resolveConfiguredSecretInputString({
      config: cfg,
      env,
      value: account.crmWebhookUrlInput,
      path: "channels.bitrix24.crmWebhookUrl",
    });
    literal = typeof resolved.value === "string" ? resolved.value.trim() : "";
  } catch {
    literal = "";
  }
  if (!literal) {
    refuse("NOT_CONFIGURED", "the read-only CRM webhook could not be resolved");
  }
  let baseUrl: string;
  try {
    baseUrl = validateBitrix24BaseUrl({
      url: literal,
      portalDomains: account.portalDomains,
      configPath: "channels.bitrix24.crmWebhookUrl",
      allowInsecureHttpForTests: account.allowInsecureHttpForTests,
      env,
    }).baseUrl;
  } catch {
    refuse("NOT_CONFIGURED", "the read-only CRM webhook is not a valid Bitrix24 webhook for the configured portal");
  }
  return {
    baseUrl,
    portalDomains: account.portalDomains,
    allowInsecureHttpForTests: account.allowInsecureHttpForTests,
    fingerprint: fingerprintSecret(baseUrl),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
  NO_CRM_ACCESS: "the service user cannot read any deal pipeline (no CRM read access)",
  ACCESS_DENIED: "the service user or its webhook may not read this",
  QUERY_LIMIT_EXCEEDED: "Bitrix24 rate limit; try again in a minute",
  OPERATION_TIME_LIMIT: "Bitrix24 time limit for this method; try again in a minute",
  TIMEOUT: "Bitrix24 did not answer in time",
  TRANSPORT_ERROR: "Bitrix24 could not be reached",
  INVALID_RESPONSE: "Bitrix24 answered in an unexpected shape",
  ABORTED: "the request was cancelled",
  METHOD_NOT_ALLOWED: "a method outside the read-only allowlist was refused",
  INTERNAL_ERROR: "the figures could not be computed",
};

function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Bitrix24Error) {
    const code = SAFE_CODE_RE.test(error.code) ? error.code : "BITRIX_ERROR";
    const message =
      UNAVAILABLE_MESSAGES[code] ??
      (/^http_\d+$/.test(code) ? "Bitrix24 answered with an HTTP error" : "Bitrix24 returned an error");
    return { code, message };
  }
  return { code: "INTERNAL_ERROR", message: UNAVAILABLE_MESSAGES.INTERNAL_ERROR as string };
}

type SectionOutcome =
  | { section: PulseSection; ok: true; output: SectionOutput<unknown>; requests: number; elapsedMs: number }
  | { section: PulseSection; ok: false; code: string; message: string; requests: number; elapsedMs: number };

const SECTION_READERS: Record<PulseSection, (run: SectionRun) => Promise<SectionOutput<unknown>>> = {
  calls: readCalls,
};

async function runSection(params: {
  section: PulseSection;
  client: Bitrix24CrmClient;
  windows: PulseWindows;
  signal: AbortSignal | undefined;
  now: () => number;
}): Promise<SectionOutcome> {
  // Each section has its own controller: when one of its requests fails, the
  // rest of that section stops instead of spending the rate budget.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (params.signal?.aborted) {
    controller.abort();
  } else {
    params.signal?.addEventListener("abort", onAbort, { once: true });
  }
  const stats = { requests: 0 };
  const started = params.now();
  try {
    const output = await SECTION_READERS[params.section]({
      client: params.client,
      windows: params.windows,
      call: { signal: controller.signal, stats },
    });
    return {
      section: params.section,
      ok: true,
      output,
      requests: stats.requests,
      elapsedMs: Math.max(0, params.now() - started),
    };
  } catch (error) {
    controller.abort();
    return {
      section: params.section,
      ok: false,
      ...describeFailure(error),
      requests: stats.requests,
      elapsedMs: Math.max(0, params.now() - started),
    };
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
  }
}

export type Bitrix24PulseDataDeps = {
  /** Trusted tool context from the host (the factory argument). */
  context: OpenClawPluginToolContext;
  log?: Bitrix24Log;
  /** Environment for SecretInput resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests: the Bitrix fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests: the clock ("now" fixes the windows) and the throttle's sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test override of the page cap (clamped to 1..40 by the client). */
  maxPages?: number;
};

function logAt(log: Bitrix24Log | undefined, level: "info" | "warn", text: string): void {
  const sink = log?.[level] ?? log?.info;
  if (typeof sink === "function") {
    sink(text);
    return;
  }
  console.log(text);
}

/**
 * Run one `bitrix24_pulse_data` call. Never throws: every outcome is a
 * `PulseDataResult`. Logs exactly one line (info with data, warn without).
 */
export async function runBitrix24PulseData(
  deps: Bitrix24PulseDataDeps,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<PulseDataResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  try {
    const args = validatePulseDataArgs(rawArgs);
    const cfg = readConfig(deps.context);
    assertBitrixAgent(deps.context, cfg);
    const target = await resolveCrmTarget(cfg, deps.env ?? process.env);
    if (signal?.aborted) {
      refuse("ABORTED", "the request was cancelled");
    }
    const client = createBitrix24CrmClient({
      baseUrl: target.baseUrl,
      portalDomains: target.portalDomains,
      allowInsecureHttpForTests: target.allowInsecureHttpForTests,
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.maxPages === undefined ? {} : { maxPages: deps.maxPages }),
      ...(deps.log ? { log: deps.log } : {}),
    });
    const windows = buildPulseWindows(startedAt);
    const outcomes = await Promise.all(
      args.sections.map((section) => runSection({ section, client, windows, signal, now })),
    );

    const unavailable: PulseUnavailable[] = [];
    const sections: PulseDataSuccess["sections"] = {};
    const elapsed: PulseDataMeta["elapsed_ms"] = { total: 0 };
    const requests: PulseDataMeta["requests"] = { total: 0 };
    const truncated: PulseDataMeta["truncated"] = {};
    for (const outcome of outcomes) {
      elapsed[outcome.section] = outcome.elapsedMs;
      requests[outcome.section] = outcome.requests;
      requests.total += outcome.requests;
      if (!outcome.ok) {
        truncated[outcome.section] = false;
        unavailable.push({ section: outcome.section, code: outcome.code, message: outcome.message });
        continue;
      }
      truncated[outcome.section] = outcome.output.truncated;
      (sections as Record<string, unknown>)[outcome.section] = outcome.output.data;
    }
    elapsed.total = Math.max(0, now() - startedAt);

    const codes = unavailable.map((u) => `${u.section}:${u.code}`).join(",") || "none";
    const truncatedList = Object.entries(truncated).filter(([, v]) => v).map(([k]) => k).join(",") || "none";
    const summary =
      `sections=${args.sections.join(",")} unavailable=${codes} truncated=${truncatedList} ` +
      `requests=${requests.total} elapsedMs=${elapsed.total} crmWebhookFp=${target.fingerprint}`;

    if (unavailable.length === outcomes.length) {
      logAt(deps.log, "warn", `[bitrix24] pulse data failed code=ALL_SECTIONS_UNAVAILABLE ${summary}`);
      return {
        ok: false,
        error_code: "ALL_SECTIONS_UNAVAILABLE",
        message: "no Bitrix24 section could be read",
        unavailable,
      };
    }
    logAt(deps.log, "info", `[bitrix24] pulse data ok ${summary}`);
    return {
      ok: true,
      as_of: windows.today,
      generated_at: tbilisiIso(startedAt),
      timezone: PULSE_TIMEZONE,
      sections,
      unavailable,
      meta: {
        sections_requested: args.sections,
        elapsed_ms: elapsed,
        requests,
        truncated,
        page_size: BITRIX24_CRM_PAGE_SIZE,
        page_cap: deps.maxPages === undefined ? BITRIX24_CRM_MAX_PAGES : Math.min(BITRIX24_CRM_MAX_PAGES, deps.maxPages),
      },
    };
  } catch (error) {
    const failure: PulseDataFailure =
      error instanceof PulseRefusal
        ? { ok: false, error_code: error.code, message: error.message }
        : { ok: false, error_code: "INTERNAL_ERROR", message: "unexpected error; no figures were read" };
    logAt(deps.log, "warn", `[bitrix24] pulse data failed code=${failure.error_code}`);
    return failure;
  }
}

/**
 * Build the concrete tool for one run. Called by the host's tool factory with
 * the trusted context; cheap and side-effect free.
 */
export function createBitrix24PulseDataTool(deps: Bitrix24PulseDataDeps): AnyAgentTool {
  return {
    name: BITRIX24_PULSE_DATA_TOOL_NAME,
    label: "Bitrix24 customer calls (read-only)",
    description: TOOL_DESCRIPTION,
    parameters: bitrix24PulseDataParameters as unknown as AnyAgentTool["parameters"],
    executionMode: "parallel",
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const result = await runBitrix24PulseData(deps, params, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
