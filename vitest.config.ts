import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every test runs against a throwaway state dir, so nothing can touch a real
// ~/.openclaw (or the pilot's config volume) while exercising the SDK ingress
// and the plugin's own JSON state store.
const stateDir = mkdtempSync(join(tmpdir(), "bitrix24-vitest-"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // No network in tests: Bitrix calls are served either by an injected fetch
    // stub or by the local fake-Bitrix HTTP server on an ephemeral loopback port.
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      OPENCLAW_STATE_DIR: stateDir,
      // Arms the http escape hatch so the fake portal can be reached without TLS.
      BITRIX24_ALLOW_INSECURE_HTTP: "1",
    },
  },
});
