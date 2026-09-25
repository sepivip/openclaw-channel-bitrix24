// Poller pacing: after an Event.get page with `hasMore: true`, Bitrix requires
// at least 2 s before the next Event.get. Fake timers, the poller's real
// (default) abortable sleep, and a scripted fake client.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BITRIX24_HAS_MORE_PAUSE_MS,
  createBitrix24Poller,
  createMemoryStateStore,
} from "../src/poller.js";
import type { Bitrix24Client } from "../src/client.js";

type Page = { events: unknown[]; nextOffset: number; hasMore: boolean };

function scriptedClient(pages: Page[]) {
  const callTimes: number[] = [];
  const offsets: unknown[] = [];
  const client: Bitrix24Client = {
    call: (async (method: string, params?: Record<string, unknown>) => {
      expect(method).toBe("imbot.v2.Event.get");
      callTimes.push(Date.now());
      offsets.push(params?.offset);
      return pages.shift() ?? { events: [], nextOffset: 99, hasMore: false };
    }) as Bitrix24Client["call"],
    describe: () => ({ host: "synthetic.bitrix24.test", userId: "7" }),
  };
  return { client, callTimes, offsets };
}

function buildPoller(client: Bitrix24Client, onEvents = vi.fn(async () => {})) {
  return createBitrix24Poller({
    client,
    accountId: "pacing",
    botId: "9001",
    botToken: "fake-bot-token",
    stateStore: createMemoryStateStore(),
    // Long adaptive intervals, so any second call inside the window can only
    // come from the hasMore drain.
    idleMs: 60_000,
    activeMs: 60_000,
    onEvents,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T08:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hasMore pacing", () => {
  it("uses the documented 2 s minimum", () => {
    expect(BITRIX24_HAS_MORE_PAUSE_MS).toBeGreaterThanOrEqual(2_000);
  });

  it("waits at least 2 s after a hasMore page before the next Event.get", async () => {
    const { client, callTimes, offsets } = scriptedClient([
      { events: [{ n: 1 }], nextOffset: 2, hasMore: true },
      { events: [{ n: 2 }], nextOffset: 3, hasMore: true },
      { events: [{ n: 3 }], nextOffset: 4, hasMore: false },
    ]);
    const onEvents = vi.fn(async () => {});
    const poller = buildPoller(client, onEvents);
    poller.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(callTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(BITRIX24_HAS_MORE_PAUSE_MS - 1);
    expect(callTimes).toHaveLength(1); // still inside the pause

    await vi.advanceTimersByTimeAsync(1);
    expect(callTimes).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(BITRIX24_HAS_MORE_PAUSE_MS - 1);
    expect(callTimes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(callTimes).toHaveLength(3);

    for (let i = 1; i < callTimes.length; i += 1) {
      expect((callTimes[i] ?? 0) - (callTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(2_000);
    }
    // Each page was acked (offset carried forward) and handed to the handler.
    expect(offsets).toEqual([undefined, "2", "3"]);
    expect(onEvents).toHaveBeenCalledTimes(3);

    // The last page had hasMore:false: the next call waits the adaptive
    // interval (60 s here), not the 2 s drain pause.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callTimes).toHaveLength(3);

    await poller.stop();
  });

  it("does not pause when hasMore is false", async () => {
    const { client, callTimes } = scriptedClient([{ events: [], nextOffset: 2, hasMore: false }]);
    const poller = buildPoller(client);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(callTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callTimes).toHaveLength(2); // idle interval, not the 2 s pause
    await poller.stop();
  });

  it("the pause is abortable: stop() during it returns promptly and no further call is made", async () => {
    const { client, callTimes } = scriptedClient([
      { events: [{ n: 1 }], nextOffset: 2, hasMore: true },
      { events: [{ n: 2 }], nextOffset: 3, hasMore: false },
    ]);
    const poller = buildPoller(client);
    poller.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(callTimes).toHaveLength(1);

    let stopped = false;
    const stopping = poller.stop().then(() => {
      stopped = true;
    });
    // No timer advance needed: abort resolves the sleep immediately.
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callTimes).toHaveLength(1);
    expect(poller.snapshot().running).toBe(false);
  });
});
