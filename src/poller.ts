// Bitrix24 `imbot.v2.Event.get` fetch-mode poll loop.
//
// Contract (apidocs `imbot.v2.Event.get`):
//   request  { botId, botToken?, offset?, limit? }   limit 1..1000, default 100
//   result   { events: [...], nextOffset, hasMore }
//   "offset — Confirms all events with IDs less than the specified value.
//    Not passed on the first call."
// So `nextOffset` is the ack: persisting it before the next call is what makes
// a restart neither replay nor skip (design §2.2 "Idempotency").
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
  /** Called once per batch. Must not throw for individual bad events. */
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
        // Drain: keep going without sleeping while Bitrix reports `hasMore`.
        for (;;) {
          const batch = await fetchOnce(signal);
          if (batch.events.length > 0) {
            sawEvents = true;
            events += batch.events.length;
            await options.onEvents(batch.events);
          }
          // Ack only AFTER the batch was handed to the handler.
          if (batch.nextOffset !== undefined && batch.nextOffset !== offset) {
            offset = batch.nextOffset;
            await options.stateStore.set(offsetKey, offset);
          }
          if (!batch.hasMore || signal.aborted) {
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
