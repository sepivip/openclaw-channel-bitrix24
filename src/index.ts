// Plugin entry point. Loaded by OpenClaw from `plugins.load.paths`.
//
// Module evaluation must stay side-effect free apart from this one log line:
// no network, no filesystem writes, no timers, and — by design — no listener.

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import {
  bitrix24Plugin,
  getRunningBitrix24AccountRuntime,
  setBitrix24Runtime,
} from "./plugin.js";
import { BITRIX24_SEND_SHEET_TOOL_NAME, createBitrix24SendSheetTool } from "./tools.js";

console.log("[bitrix24] module evaluated (imbot.v2 fetch mode; no inbound HTTP surface).");

export default defineChannelPluginEntry({
  id: "bitrix24",
  name: "Bitrix24",
  description:
    "Bitrix24 channel plugin (imbot.v2 fetch mode, outbound-only, no inbound HTTP surface)",
  plugin: bitrix24Plugin,
  setRuntime(runtime) {
    setBitrix24Runtime(runtime);
    console.log(
      "[bitrix24] channel registered. Accounts start only when channels.bitrix24.enabled === true " +
        "and both secrets resolve; otherwise nothing is started and no Bitrix24 call is made.",
    );
  },
  // Runs for "full" and "tool-discovery" loads only. Registers the one agent
  // tool, declared in openclaw.plugin.json `contracts.tools`. The factory is
  // cheap and does no I/O; every check runs when the tool is called. The tool
  // is optional: an agent sees it only when its tool policy allows it by name.
  registerFull(api) {
    api.registerTool(
      (toolContext) =>
        createBitrix24SendSheetTool({
          context: toolContext,
          getAccountRuntime: getRunningBitrix24AccountRuntime,
          log: api.logger,
        }),
      { name: BITRIX24_SEND_SHEET_TOOL_NAME, optional: true },
    );
  },
});

export { bitrix24Plugin } from "./plugin.js";
