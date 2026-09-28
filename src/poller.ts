// Bitrix24 `imbot.v2.Event.get` fetch-mode poll loop.
//
// Contract (apidocs `imbot.v2.Event.get`):
//   request  { botId, botToken?, offset?, limit? }   limit 1..1000, default 100
//   result   { events: [...], nextOffset, hasMore }
//   "offset — Confirms all events with IDs less than the specified value.
//    Not passed on the first call."
//   After `hasMore: true`, wait at least 2 s before the next Event.get.
// So `nextOffset` is the ack: persisting it before the next call is what makes
// a restart neither replay nor skip (design §2.2 "Idempotency"). A stop can end
// a batch between two events; the offset saved then is the id of the first
// event not handed over, so the next start fetches exactly the rest.
//
// This module makes no network call on import. `start()` is only reached from
// `gateway.startAccount` after fail-closed secret validation.

import type { Bitrix24Client } from "./client.js";
import { backoffMs } from "./client.js";
import { Bitrix24Error } from "./secrets.js";
import { BITRIX24_STATE_KEY_OFFSET, type StateStore } from "./state-store.js";

export { createMemoryStateStore, type StateStore } from "./state-store.js";

export type Bitrix24EventBatch = {
  events: unknown[];
  nextOffset: string | undefined;
  hasMore: boolean;
};

export type Bitrix24PollerOptions = {
  client: Bitrix24Client;
  accountId: string;
  botId: string | number;
  botToken: string;
  stateStore: StateStore;
  idleMs: number;
  activeMs: number;
  /**
   * Handed one event at a time (a one-element array), in batch order, so a
   * stop can end a batch between two events. Must not throw for individual
   * bad events, and must not skip an event it was handed: it counts as
   * handled once this returns.
   */
  onEvents: (events: unknown[]) => Promise<void> | void;
  log?: (message: string) => void;
  /** Account health transitions. Never throws out of the loop. */
  onDegraded?: (reason: string) => void;
  onHealthy?: () => void;
  /** Injected for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  maxBackoffAttempts?: number;
  /** State-store key holding the acknowledged offset. */
  offsetKey?: string;
  /** Bitrix `limit` (1..1000). */
  limit?: number;
};

export type Bitrix24Poller = {
  start(): void;
  stop(): Promise<void>;
  /** Diagnostics only; never contains credentials. */
  snapshot(): {
    running: boolean;
    offset: string | undefined;
    consecutiveFailures: number;
    polls: number;
    events: number;
  };
};

export const BITRIX24_EVENT_LIMIT = 100;

/**
 * imbot.v2 `Event.get`: after a response with `hasMore: true`, Bitrix requires
 * a pause of at least 2 seconds before the next `Event.get`. Not configurable,
 * so it can not be set below the documented minimum.
 */
export const BITRIX24_HAS_MORE_PAUSE_MS = 2_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseBitrix24EventBatch(result: unknown): Bitrix24EventBatch {
  const record = (result ?? {}) as {
    events?: unknown;
    nextOffset?: unknown;
    hasMore?: unknown;
  };
  const events = Array.isArray(record.events) ? record.events : [];
  const nextOffset =
    record.nextOffset === undefined || record.nextOffset === null
      ? undefined
      : String(record.nextOffset);
  return { events, nextOffset, hasMore: record.hasMore === true };
}

function toEventNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The offset that acknowledges every event of a batch before `event` and none
 * from it on: its own `eventId` (Event.get `offset` "Confirms all events with
 * IDs less than the specified value"). Only an integer id inside the batch's
 * own range (`offset` <= id < `nextOffset`) qualifies, so an id that is not an
 * Event.get offset can never acknowledge an event that was not handed over.
 * `undefined` otherwise; a stop then does not end the batch in front of it.
 */
export function bitrix24OffsetBefore(
  event: unknown,
  batch: { offset: string | undefined; nextOffset: string | undefined },
): string | undefined {
  const id = toEventNumber((event as { eventId?: unknown } | null | undefined)?.eventId);
  const low = batch.offset === undefined ? 0 : toEventNumber(batch.offset);
  const high = toEventNumber(batch.nextOffset);
  if (id === undefined || low === undefined || high === undefined || id < low || id >= high) {
    return undefined;
  }
  return String(id);
}

export function createBitrix24Poller(options: Bitrix24PollerOptions): Bitrix24Poller {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxBackoffAttempts = options.maxBackoffAttempts ?? 8;
  const offsetKey = options.offsetKey ?? BITRIX24_STATE_KEY_OFFSET;
  const limit = options.limit ?? BITRIX24_EVENT_LIMIT;

  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let offset: string | undefined;
  let consecutiveFailures = 0;
  let polls = 0;
  let events = 0;
  let degraded = false;

  async function fetchOnce(signal: AbortSignal): Promise<Bitrix24EventBatch> {
    polls += 1;
    const result = await options.client.call<unknown>(
      "imbot.v2.Event.get",
      {
        botId: options.botId,
        botToken: options.botToken,
        limit,
        // "Not passed on the first call."
        ...(offset === undefined ? {} : { offset }),
      },
      { signal },
    );
    return parseBitrix24EventBatch(result);
  }

  function markDegraded(reason: string): void {
    if (degraded) {
      return;
    }
    degraded = true;
    try {
      options.onDegraded?.(reason);
    } catch {
      /* a status sink must never take the poller down */
    }
  }

  function markHealthy(): void {
    if (!degraded) {
      return;
    }
    degraded = false;
    try {
      options.onHealthy?.();
    } catch {
      /* ignore */
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    try {
      offset = await options.stateStore.get(offsetKey);
    } catch {
      offset = undefined;
    }
    if (offset !== undefined) {
      options.log?.(`[bitrix24] resuming poll from persisted offset=${offset}`);
    }
    while (!signal.aborted) {
      let sawEvents = false;
      try {
        // Drain while Bitrix reports `hasMore`, pausing BITRIX24_HAS_MORE_PAUSE_MS
        // (abortable) between pages as the Event.get contract requires.
        for (;;) {
          const batch = await fetchOnce(signal);
          let ackOffset = batch.nextOffset;
          // One event at a time, so a stop (a channel restart after a config
          // change, or shutdown) ends the batch between two events: each event
          // is awaited through its whole agent turn, which can take minutes,
          // and a stop should wait for the turn in flight only.
          for (const event of batch.events) {
            if (signal.aborted) {
              const before = bitrix24OffsetBefore(event, {
                offset,
                nextOffset: batch.nextOffset,
              });
              if (before !== undefined) {
                // Acknowledge only what was handed over; the next start
                // fetches the rest from here.
                ackOffset = before;
                break;
              }
              // No usable id to acknowledge up to: hand it over too, rather
              // than drop it (acknowledged, never handled) or replay the
              // events already handled.
            }
            sawEvents = true;
            events += 1;
            await options.onEvents([event]);
          }
          // Ack only AFTER the events were handed to the handler.
          if (ackOffset !== undefined && ackOffset !== offset) {
            offset = ackOffset;
            await options.stateStore.set(offsetKey, offset);
          }
          if (!batch.hasMore || signal.aborted) {
            break;
          }
          await sleep(BITRIX24_HAS_MORE_PAUSE_MS, signal);
          if (signal.aborted) {
            break;
          }
        }
        consecutiveFailures = 0;
        markHealthy();
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        consecutiveFailures += 1;
        // Only ever log the wrapped, credential-free projection.
        const wrapped = error instanceof Bitrix24Error ? error : undefined;
        const fields = wrapped ? JSON.stringify(wrapped.toLogFields()) : `{"code":"UNEXPECTED"}`;
        options.log?.(
          `[bitrix24] poll failed (${consecutiveFailures} in a row) ${fields}; backing off`,
        );
        markDegraded(wrapped ? `${wrapped.code}` : "poll_failed");
        const wait = backoffMs(Math.min(consecutiveFailures - 1, maxBackoffAttempts), random);
        await sleep(wait, signal);
        continue;
      }
      // Adaptive interval: fast after events, slow when idle.
      await sleep(sawEvents ? options.activeMs : options.idleMs, signal);
    }
  }

  return {
    start() {
      if (controller) {
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      // A rejected loop would become an unhandled rejection and could take the
      // Gateway down; it is caught here and reported as degraded instead.
      loop = run(signal).catch((error: unknown) => {
        const wrapped = error instanceof Bitrix24Error ? error : undefined;
        options.log?.(
          `[bitrix24] poll loop exited unexpectedly ` +
            (wrapped ? JSON.stringify(wrapped.toLogFields()) : `{"code":"UNEXPECTED"}`),
        );
        markDegraded("poll_loop_exited");
      });
    },
    async stop() {
      controller?.abort();
      controller = undefined;
      await loop;
      loop = undefined;
    },
    snapshot() {
      return { running: Boolean(controller), offset, consecutiveFailures, polls, events };
    },
  };
}
