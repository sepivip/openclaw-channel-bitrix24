// FAKE BITRIX24 CRM PORTAL for the Gate 2 pulse tests: an injected `fetch`,
// no socket, no network. It serves the three read methods of the CRM
// allowlist (crm.category.list, crm.status.list, crm.item.list) over a
// synthetic dataset and emulates just enough of Bitrix: `start`/`next`/`total`
// paging (50 per page), the filter keys and orders the pulse sends, `select`,
// and error injection per method. It throws on a filter key it does not know,
// so a typo in the plugin fails a test instead of passing silently. Every id,
// name and value is invented.
//
// Also: `createScheduledClock`, a deterministic clock for concurrent code. A
// `sleep` only resolves when the driver advances time to it, so concurrent
// waiters see one consistent "now" (an instant-advance sleep does not).

export const FAKE_CRM_BASE_URL = "https://synthetic.bitrix24.test/rest/77/crmReadS3cretT0ken/";
export const FAKE_CRM_SECRET = "crmReadS3cretT0ken";

/** A deal as the portal stores it. The personal fields must never be selected. */
export type FakeDeal = {
  id: number;
  categoryId: number;
  stageId: string;
  stageSemanticId: "P" | "S" | "F";
  createdTime: string;
  movedTime: string;
  title: string;
  opportunity: number;
  assignedById: number;
  sourceId: string;
  contactId: number;
};

export type FakeCategory = { id: number; name: string; sort: number; isDefault?: "Y" | "N" };

export type FakeStage = {
  ENTITY_ID: string;
  STATUS_ID: string;
  NAME: string;
  SORT: string;
  SEMANTICS: string | null;
  EXTRA?: { SEMANTICS?: string };
};

export type FakeCrmData = {
  categories: FakeCategory[];
  stages: FakeStage[];
  deals: FakeDeal[];
};

export type FakeCall = { method: string; params: Record<string, unknown>; at: number };

type Responder = (params: Record<string, unknown>, callIndex: number) => Response | undefined;

const PAGE = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ms(value: unknown): number {
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    throw new Error(`fake portal: unparseable date in filter: ${String(value)}`);
  }
  return parsed;
}

function page<T>(rows: T[], params: Record<string, unknown>, wrap: (rows: T[]) => unknown) {
  const start = typeof params.start === "number" ? params.start : 0;
  const slice = rows.slice(start, start + PAGE);
  const next = start + PAGE < rows.length ? start + PAGE : undefined;
  return json({ result: wrap(slice), total: rows.length, ...(next === undefined ? {} : { next }) });
}

function pick(row: Record<string, unknown>, select: unknown): Record<string, unknown> {
  if (!Array.isArray(select) || select.length === 0 || select.includes("*")) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const key of select as string[]) {
    if (key in row) {
      out[key] = row[key];
    }
  }
  return out;
}

function filterDeals(deals: FakeDeal[], filter: Record<string, unknown>): FakeDeal[] {
  return deals.filter((deal) =>
    Object.entries(filter).every(([key, value]) => {
      switch (key) {
        case "stageSemanticId":
          return deal.stageSemanticId === value;
        case ">=movedTime":
          return ms(deal.movedTime) >= ms(value);
        case "<movedTime":
          return ms(deal.movedTime) < ms(value);
        case ">=createdTime":
          return ms(deal.createdTime) >= ms(value);
        case "<createdTime":
          return ms(deal.createdTime) < ms(value);
        default:
          throw new Error(`fake portal: unknown crm.item.list filter key ${key}`);
      }
    }),
  );
}

function orderDeals(deals: FakeDeal[], order: unknown): FakeDeal[] {
  const spec = (order ?? {}) as Record<string, unknown>;
  const keys = Object.keys(spec);
  if (keys.length === 0 || (keys.length === 1 && spec.id === "ASC")) {
    return [...deals].sort((a, b) => a.id - b.id);
  }
  if (keys.length === 1 && spec.createdTime === "ASC") {
    return [...deals].sort((a, b) => ms(a.createdTime) - ms(b.createdTime) || a.id - b.id);
  }
  throw new Error(`fake portal: unsupported order ${JSON.stringify(order)}`);
}

export type FakeCrmPortal = {
  fetch: typeof fetch;
  calls: FakeCall[];
  /** Override a method's answer. Return `undefined` to fall through to the dataset. */
  respond: (method: string, responder: Responder) => void;
  methods: () => string[];
  count: (method: string) => number;
};

export function createFakeCrmPortal(
  data: FakeCrmData,
  opts: { now: () => number; baseUrl?: string },
): FakeCrmPortal {
  const baseUrl = opts.baseUrl ?? FAKE_CRM_BASE_URL;
  const calls: FakeCall[] = [];
  const responders = new Map<string, Responder>();
  const perMethod = new Map<string, number>();

  function serve(method: string, params: Record<string, unknown>): Response {
    const index = perMethod.get(method) ?? 0;
    perMethod.set(method, index + 1);
    const override = responders.get(method)?.(params, index);
    if (override) {
      return override;
    }
    switch (method) {
      case "crm.category.list": {
        if (params.entityTypeId !== 2) {
          throw new Error("fake portal: crm.category.list expects entityTypeId 2");
        }
        return page(data.categories, params, (rows) => ({ categories: rows }));
      }
      case "crm.status.list": {
        const filter = (params.filter ?? {}) as Record<string, unknown>;
        const rows = data.stages.filter((s) => s.ENTITY_ID === filter.ENTITY_ID);
        return json({ result: rows, total: rows.length });
      }
      case "crm.item.list": {
        if (params.entityTypeId !== 2) {
          throw new Error("fake portal: crm.item.list expects entityTypeId 2");
        }
        const filter = (params.filter ?? {}) as Record<string, unknown>;
        const rows = orderDeals(filterDeals(data.deals, filter), params.order).map((deal) =>
          pick(deal as unknown as Record<string, unknown>, params.select),
        );
        return page(rows, params, (slice) => ({ items: slice }));
      }
      default:
        return json({ error: "ERROR_METHOD_NOT_FOUND", error_description: "Method not found!" }, 404);
    }
  }

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const text = String(url);
    if (!text.startsWith(baseUrl)) {
      throw new Error("fake portal: request to an unexpected base URL");
    }
    const method = text.slice(baseUrl.length);
    const params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, params, at: opts.now() });
    return serve(method, params);
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    respond: (method, responder) => {
      responders.set(method, responder);
    },
    methods: () => calls.map((c) => c.method),
    count: (method) => calls.filter((c) => c.method === method).length,
  };
}

/** Bitrix JSON error answer helper for `respond`. */
export function bitrixError(code: string, status: number, description = "synthetic failure"): Response {
  return json({ error: code, error_description: description }, status);
}

export type ScheduledClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  readonly t: number;
  /** Drive `promise` to completion, advancing time only when nothing else can run. */
  run: <T>(promise: Promise<T>) => Promise<T>;
};

export function createScheduledClock(start: number): ScheduledClock {
  let t = start;
  let seq = 0;
  const timers: Array<{ at: number; seq: number; resolve: () => void }> = [];
  const sleeps: number[] = [];
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    sleep: (delay: number) => {
      sleeps.push(delay);
      return new Promise<void>((resolve) => {
        timers.push({ at: t + Math.max(0, delay), seq: seq++, resolve });
      });
    },
    sleeps,
    get t() {
      return t;
    },
    async run<T>(promise: Promise<T>): Promise<T> {
      let settled = false;
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let idle = 0;
      while (!settled) {
        await settle();
        if (settled) {
          break;
        }
        if (timers.length === 0) {
          idle += 1;
          if (idle > 10_000) {
            throw new Error("scheduled clock: nothing left to run");
          }
          continue;
        }
        idle = 0;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift()!;
        t = Math.max(t, next.at);
        next.resolve();
      }
      return promise;
    },
  };
}
