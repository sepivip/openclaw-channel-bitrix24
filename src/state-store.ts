// Per-account plugin state (`botId`, poll `offset`) persisted as JSON.
//
// Why a file and not an SDK helper: the 2026.9.4 plugin SDK exports no
// per-plugin key/value store. What it DOES export is the canonical state
// directory resolver used by the rest of the runtime:
//   `resolveStateDir(env?, homedir?)` from `openclaw/plugin-sdk/state-paths`
//   (dist/state-dir-CrCP_VLr.d.ts: "State directory for mutable data ...
//    Can be overridden via OPENCLAW_STATE_DIR. Default: ~/.openclaw").
// That directory is the config volume, so `openclaw backup create` already
// captures the file (design §4).
//
// Layout: <stateDir>/channels/bitrix24/<accountId>.json
//   { "botId": "777", "offset": "1002" }
//
// Writes are atomic (temp file + rename) and serialized per store instance, so
// a crash mid-write can never leave a truncated offset behind. Nothing secret
// is ever written here: `botId` is a portal-public integer and `offset` is an
// event cursor.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/** Minimal persistence seam consumed by the poller. Keys are JSON top-level keys. */
export type StateStore = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
};

export const BITRIX24_STATE_KEY_BOT_ID = "botId";
export const BITRIX24_STATE_KEY_OFFSET = "offset";

/** In-memory fallback. Loses state across restarts — dev/test only. */
export function createMemoryStateStore(initial?: Record<string, string>): StateStore {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

/** Sanitize an account id into one safe path segment. */
function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "default";
}

/**
 * Resolve the state file for one Bitrix24 account.
 *
 * `stateDir` wins when supplied (tests); otherwise the runtime's own state dir
 * is used, which honours `OPENCLAW_STATE_DIR` exactly like core does.
 */
export function resolveBitrix24StatePath(params: {
  accountId: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const base = params.stateDir ?? resolveStateDir(params.env ?? process.env);
  return join(base, "channels", "bitrix24", `${safeSegment(params.accountId)}.json`);
}

export type Bitrix24FileStateStore = StateStore & {
  /** Absolute path of the backing file. Safe to log: contains no credential. */
  readonly filePath: string;
  /** Whole-record read, used by `startAccount` to recover a persisted `botId`. */
  readAll(): Promise<Record<string, string>>;
};

/**
 * JSON-file state store for one account.
 *
 * Read failures (missing file, corrupt JSON) degrade to an empty record rather
 * than throwing: a lost offset replays at most one Bitrix batch, while a throw
 * here would take the account down.
 */
export function createFileStateStore(params: {
  accountId: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  onError?: (message: string) => void;
}): Bitrix24FileStateStore {
  const filePath = resolveBitrix24StatePath({
    accountId: params.accountId,
    ...(params.stateDir === undefined ? {} : { stateDir: params.stateDir }),
    ...(params.env === undefined ? {} : { env: params.env }),
  });
  // Serializes every read-modify-write so concurrent `set` calls cannot
  // interleave and drop a key.
  let queue: Promise<unknown> = Promise.resolve();
  let cache: Record<string, string> | undefined;

  async function loadUncached(): Promise<Record<string, string>> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") {
          out[key] = value;
        } else if (typeof value === "number" || typeof value === "bigint") {
          out[key] = String(value);
        }
      }
      return out;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        params.onError?.(
          `[bitrix24] state file unreadable (${code ?? "parse_error"}); starting from empty state`,
        );
      }
      return {};
    }
  }

  async function load(): Promise<Record<string, string>> {
    cache ??= await loadUncached();
    return cache;
  }

  async function persist(next: Record<string, string>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    filePath,
    async readAll() {
      return enqueue(async () => ({ ...(await load()) }));
    },
    async get(key) {
      return enqueue(async () => (await load())[key]);
    },
    async set(key, value) {
      await enqueue(async () => {
        const current = await load();
        if (current[key] === value) {
          return;
        }
        const next = { ...current, [key]: value };
        await persist(next);
        cache = next;
      });
    },
  };
}
