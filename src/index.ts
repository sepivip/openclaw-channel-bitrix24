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
import { BITRIX24_PULSE_DATA_TOOL_NAME, createBitrix24PulseDataTool } from "./pulse-data.js";
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
  // Runs for "full" and "tool-discovery" loads only. Registers the agent
  // tools, declared in openclaw.plugin.json `contracts.tools`. The factories
  // are cheap and do no I/O; every check runs when a tool is called. Both
  // tools are optional: an agent sees one only when its tool policy allows it
  // by name (`alsoAllow`).
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
    // Read-only business pulse figures (Gate 2) over the separate CRM webhook.
    api.registerTool(
      (toolContext) => createBitrix24PulseDataTool({ context: toolContext, log: api.logger }),
      { name: BITRIX24_PULSE_DATA_TOOL_NAME, optional: true },
    );
  },
});

export { bitrix24Plugin } from "./plugin.js";
