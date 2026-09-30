# Changelog

## 0.2.0 (2026-09-30)

First release on ClawHub, as `@sepivip/openclaw-channel-bitrix24`. The plugin
id stays `bitrix24`, so existing `channels.bitrix24` and
`plugins.entries.bitrix24` config keeps working.

- Package metadata for ClawHub and `openclaw plugins install`: scoped name,
  `openclaw.compat`, `openclaw.build` and `openclaw.install`, and a `files`
  list so the published package carries the built `dist/`.
- The README is now an install and setup guide. Tool contracts, group-chat
  admission and the Docker named-volume install moved to `docs/`.
- No deprecated plugin-SDK barrels: pairing requests use the runtime pairing
  API and the command-auth import moved to `command-auth-native`. Loads with
  `compatibility: []` on OpenClaw 2026.9.4, 2026.9.6 and 2026.9.7.
- New optional read-only tool `bitrix24_pulse_data` (customer-call summary from
  CRM deals, through a separate `crm` webhook limited to three read methods).
- A change under `channels.bitrix24` restarts only this channel, not the
  gateway (`reload.configPrefixes`).
- New optional tool `bitrix24_send_sheet`: posts a server-built `.xlsx` into
  the current chat.
- Group chats: approved chats only, @mention required, allowlisted senders
  only, and a hard guard for extranet, collaber and Open Lines chats.
- Cards and buttons in replies degrade to plain text.
- Shell scripts keep LF line endings in every checkout.

## 0.1.0 (2026-09-18)

Initial version: `imbot.v2` in fetch mode, direct messages with an allowlist,
a hard-coded Bitrix24 method allowlist, and no inbound HTTP surface.
