# openclaw-channel-bitrix24

An OpenClaw **channel plugin** that bridges a Bitrix24 portal's `imbot.v2` chat bot to an OpenClaw agent, in **fetch mode** (Path B): the plugin polls `imbot.v2.Event.get` outbound over the portal's inbound-webhook URL.

**There is no inbound HTTP surface.** No gateway HTTP route, no express, no listener, no published port, no tunnel, no DNS. Webhook forgery is eliminated by construction.

Target runtime: `ghcr.io/openclaw/openclaw:2026.9.4` or later.

## Path A vs Path B

- **Path A** (rejected): Bitrix24 posts events to a public webhook endpoint. Risk: webhook forgery without a verifiable signature.
- **Path B** (this plugin): OpenClaw polls Bitrix24's event queue via `imbot.v2.Event.get`. No inbound HTTP, no forgery surface.

This is a **community plugin** implementing Path B after Path A was rejected for security concerns.

## Security Properties

* **Hardcoded method allowlist**: exactly six methods allowed:
  - `imbot.v2.Bot.register`
  - `imbot.v2.Bot.update`
  - `imbot.v2.Event.get`
  - `imbot.v2.Chat.Message.send`
  - `imbot.v2.Chat.InputAction.notify`
  - `imbot.v2.File.upload` (called only by the [`bitrix24_send_sheet`](#sending-sheets-bitrix24_send_sheet) tool)
  
  Any other method name throws synchronously. Scope creep is structurally impossible. All six need only the `imbot` scope.

* **One base URL, validated at config load**: `https:` only, path must match `/rest/<digits>/<token>/`, host must end with the configured `portalDomain`.

* **Secrets never reach a logger**: Every HTTP failure is wrapped before logging. Webhook URLs are never log fields; only `sha256(secret).hex.slice(0,16)` fingerprints appear.

* **Default deny, enforced by core**: Per-event admission is decided by OpenClaw SDK ingress. `dmPolicy` defaults to `allowlist`; there is no `"open"` value. `allowFrom` accepts numeric Bitrix user ids only.

* **Groups off by default, allowlisted when on**: `groupPolicy` is `"disabled"` (default) or `"allowlist"`; there is no `"open"`. Under `allowlist` only chats listed in `groups` (keys `chat<N>`) are eligible, and a turn starts only when the bot is @mentioned AND the sender is in `allowFrom`. See [Group chats](#group-chats).

* **Hard guard before policy**: Extranet chats, chats with collabers, Open Lines / entity-linked chats, non-`chat` group types, and extranet / connector / bot / external-auth senders are refused before config, ingress or any reply (`src/guard.ts`). Fail closed: a missing safety field on a group counts as unsafe.

* **Loop guard**: `data.message.authorId === botId || data.user.id === botId || data.user.bot === true` ⇒ dropped before ingress. This covers the bot's own file messages too.

* **Files only through one tool**: replies never carry media. A file is sent only by the `bitrix24_send_sheet` agent tool, into the chat of the turn that called it. See [Sending sheets](#sending-sheets-bitrix24_send_sheet).

* **Rate limits**: Token bucket 1.5 req/s, burst 20; exponential backoff with jitter on rate-limit errors; 20s timeout per request.

* **Zero runtime dependencies**: The loaded artefact imports only `openclaw/plugin-sdk/*` and Node built-ins.

## Installation

### 1. Build the plugin

```bash
npm ci
npm run build     # tsc -> dist/*.js
npm test          # optional: 600 tests, no network egress
```

### 2. Deploy to Docker volume

OpenClaw requires plugins to have correct POSIX ownership and permissions. A Windows bind mount cannot express these, so use a Docker named volume:

```bash
./scripts/sync-plugin-to-volume.sh --dry-run  # inspect first
./scripts/sync-plugin-to-volume.sh            # sync to openclaw-plugins volume
```

The script:
- Creates/updates a named volume `openclaw-plugins` (customizable with `--volume`)
- Copies `dist/`, `package.json`, and `openclaw.plugin.json`
- Sets ownership to `1000:1000` (OpenClaw's `node` user)
- Sets permissions: `755` for directories, `644` for files

### 3. Mount the volume in your compose stack

Merge `docker-compose.bitrix24.yml` on top of your main compose file:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.bitrix24.yml \
  up -d
```

This adds:
- Read-only mount: `openclaw-plugins:/opt/plugins:ro`
- Environment variable passthroughs: `BITRIX24_WEBHOOK_URL`, `BITRIX24_BOT_TOKEN`

### 4. Configure credentials

Add to your `.env` file (gitignored, access-controlled):

```bash
BITRIX24_WEBHOOK_URL=https://your-portal.bitrix24.eu/rest/123/abc123def456/
BITRIX24_BOT_TOKEN=your_generated_token_here
```

The webhook URL format: `https://<portal>/rest/<userId>/<token>/`

The bot token: caller-generated, ≤40 characters, used for webhook authentication.

### 5. Configure OpenClaw

Apply configuration via CLI (never hand-edit `openclaw.json`):

```bash
docker compose -f docker-compose.yml -f docker-compose.bitrix24.yml \
  run --rm openclaw-cli config set --batch-json '{
    "plugins.load.paths": ["/opt/plugins/bitrix24"],
    "plugins.entries.bitrix24.enabled": true,
    "channels.bitrix24.enabled": false,
    "channels.bitrix24.webhookUrl": "${BITRIX24_WEBHOOK_URL}",
    "channels.bitrix24.botToken": "${BITRIX24_BOT_TOKEN}",
    "channels.bitrix24.portalDomain": "your-portal.bitrix24.eu",
    "channels.bitrix24.dmPolicy": "allowlist",
    "channels.bitrix24.allowFrom": [],
    "channels.bitrix24.groupPolicy": "disabled",
    "channels.bitrix24.bot.code": "openclaw_bot",
    "channels.bitrix24.bot.name": "Assistant",
    "channels.bitrix24.bot.color": "PURPLE",
    "channels.bitrix24.bot.workPosition": "AI Assistant",
    "channels.bitrix24.poll.idleMs": 15000,
    "channels.bitrix24.poll.activeMs": 3000
  }'
```

**Important**: `channels.bitrix24.enabled` is initially `false`. Nothing starts until you explicitly enable it.

### 6. Configure allowlist

Add Bitrix24 user IDs to `allowFrom`:

```bash
docker compose run --rm openclaw-cli config set \
  channels.bitrix24.allowFrom "[\"12345\",\"67890\"]"
```

Replace `12345` and `67890` with actual numeric Bitrix24 user IDs who should be allowed to use the bot.

### 7. Enable the channel

When ready:

```bash
docker compose run --rm openclaw-cli config set \
  channels.bitrix24.enabled true
```

Validate and restart:

```bash
docker compose run --rm openclaw-cli config validate
docker compose restart openclaw-gateway
```

## Configuration Reference

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Default `false`. Nothing starts until explicitly `true`. |
| `webhookUrl` | SecretInput | Bitrix24 inbound webhook base URL. Use `${BITRIX24_WEBHOOK_URL}`. |
| `botToken` | SecretInput | Caller-generated bot token (≤40 chars). Use `${BITRIX24_BOT_TOKEN}`. |
| `portalDomain` | string | Portal domain for URL validation, e.g. `example.bitrix24.eu`. |
| `dmPolicy` | enum | `"allowlist"` \| `"pairing"` \| `"disabled"`. Default `"allowlist"`. No `"open"` value. |
| `allowFrom` | array | Numeric Bitrix24 user IDs. Empty = nobody allowed. |
| `groupPolicy` | enum | `"disabled"` \| `"allowlist"`. Default `"disabled"`. No `"open"` value. See [Group chats](#group-chats). |
| `groups` | object | Eligible group chats keyed by dialog id `chat<N>`: `{ "chat<N>": { requireMention?: boolean } }`, `requireMention` default `true`. Unlisted chats are ignored. |
| `bot.code` | string | Bot identifier. Default `"openclaw_bot"`. |
| `bot.name` | string | Display name. Default `"Assistant"`. |
| `bot.color` | string | Bot color. Default `"PURPLE"`. |
| `bot.workPosition` | string | Bot subtitle. Default `"AI Assistant"`. |
| `poll.idleMs` | integer | Poll interval when idle (≥1000ms). Default `15000`. |
| `poll.activeMs` | integer | Poll interval when active (≥500ms). Default `3000`. |

### Applying changes

A change under `channels.bitrix24.*` (for example approving a chat in
`groups`, or `groupPolicy`) restarts only the Bitrix24 channel: polling pauses
briefly and the gateway keeps running. The account reads its config once when
it starts, so it needs a restart to see a change, but not a whole-gateway one;
the plugin declares `reload.configPrefixes: ["channels.bitrix24"]` so OpenClaw
restarts just this channel. The restart waits for the message being answered,
if any (its reply still goes out), saves the poll offset after it, and the new
poll loop resumes from there: nothing is skipped or answered twice.

## Group chats

Off by default. Enabling needs both keys, and only listed chats are eligible:

```json5
channels: {
  bitrix24: {
    groupPolicy: "allowlist",                 // default "disabled"; there is no "open"
    groups: { "chat<N>": { requireMention: true } },  // requireMention defaults to true
    // group senders are matched against allowFrom; there is no separate groupAllowFrom
  },
},
```

Per `ONIMBOTV2MESSAGEADD`, in this order (`src/inbound.ts`):

1. **Loop guard.** The bot's own messages and bot senders are dropped.
2. **Hard guard** (`src/guard.ts`), every event, DM or group. Refused (no
   reply, info log `reason=<rule>`): `chat.entityType` non-empty (Open Lines
   and any entity-linked chat); `chat.extranet === true`;
   `chat.containsCollaber === true`; sender `extranet`, `connector` or `bot`;
   sender `externalAuthId` one of the documented external types `email`,
   `replica`, `bot`, `imconnector`. This is a denylist: employees carry
   `default`, `socservices` (social/SSO sign-in) or other values, and those
   pass this rule; they still have to be on `allowFrom`. Groups additionally
   need `chat.extranet === false` and `chat.containsCollaber === false` (a
   missing field is unsafe), `chat.type === "chat"`, `chat.messageType` absent
   or `"C"`, and `user.id` equal to `message.authorId`. A DM needs a numeric
   dialog id. A normal employee's DM behaves as before.
3. **Eligibility.** A group is ignored (info log) unless `groupPolicy` is
   `allowlist` and its dialog id is a key of `groups`.
4. **Mention** (`src/mentions.ts`): the bot's `[USER=<botId>]…[/USER]`, with
   `<botId>` = `data.bot.id`, is detected and stripped. The format is not
   documented but was confirmed on a real v2 group event: `message.params` is
   empty and there is no structured mentions field. The stripped text is what
   the agent sees and what commands are parsed from. Bitrix itself sends no
   event for an unmentioned group message to a `bot`-type bot, so core's
   `requireMention` gate is a second layer.
5. **Core ingress** decides: `groupPolicy`, `groupAllowFrom = allowFrom`, and
   the activation gate (`mentionFacts` + `requireMention`,
   `allowTextCommands: false`, so not even a command bypasses the mention).
6. **Session.** A group runs in its own session
   (`agent:<agent>:bitrix24:group:chat<N>`, core's default
   `session.groupScope: "per-group"`). If config folds groups into the main
   session, the message is refused with a warning.

Commands stay owner-only through core's `commands.allowFrom`, which matches
the sender id; the plugin hands core the real author (`data.user.id`,
falling back to `message.authorId`) and the mention-stripped command text.
Replies in a group are visible to every member of that chat.

`ONIMBOTV2JOINCHAT` (bot added to a chat) is logged once at info with the
dialog id, who added the bot, the chat type, the hard-guard verdict and
whether the chat is listed. The bot never replies to it. When the bot created
the chat itself, Bitrix reports the bot as the user who added it; that is
logged as `addedBy=self` (another bot: `addedBy=bot:<id>`).

The poller waits 2 s after an `Event.get` page with `hasMore: true` before
fetching the next one, as the imbot.v2 contract requires.

## Reply delivery

Core hands this channel the raw reply payload (`preparePayload`, then
`deliverWithProviderMessageSending`) and renders no cards on this route.
`src/delivery.ts` degrades everything to plain text with the SDK's own
renderers (`openclaw/plugin-sdk/interactive-runtime`): a presentation with
`presentationTextMode: "fallback"` sends its text (for example `/status`); any
other presentation, and legacy `interactive` buttons, are rendered as text
lines (command buttons show the command; callback values are never shown).
`channelData` is opaque transport data: with text the text is sent, alone it
is declined. Media in a reply is never sent (files go only through the
`bitrix24_send_sheet` tool, below). A payload with nothing visible is declined
with a warning naming the reply kind and the payload's key names; no content
is logged, and no empty message is ever sent.

## Sending sheets (`bitrix24_send_sheet`)

The plugin registers one agent tool, `bitrix24_send_sheet`. It asks a local
export service for a server-built `.xlsx` and posts it into the **current**
Bitrix24 chat with `imbot.v2.File.upload`. The rows and the file bytes never
pass through the model; the model gets a short summary computed by the server.

**Arguments** (JSON Schema, `additionalProperties: false`):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["kind"],
  "properties": {
    "kind": { "type": "string", "enum": ["stock"] },
    "warehouse_code": { "type": "string", "pattern": "^[A-Za-z0-9-]{1,32}$" },
    "as_of": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    "lang": { "type": "string", "enum": ["en", "ka"] }
  }
}
```

There is no chat, dialog, user or target argument. The arguments are
validated again at runtime, and any other key (`dialogId`, `chatId`, `to`,
`target`, ...) is refused with `TARGET_NOT_ALLOWED`.

**Where the file goes.** Only to the trusted turn context that core hands the
tool (`deliveryContext`): its channel must be `bitrix24` and its target a
numeric user id (DM) or `chat<N>` (group).

**Who asked for it.** The turn must also name the Bitrix24 user who wrote
(`requesterSenderId`); real Bitrix24 turns always do. Outside a Bitrix24 turn
the tool refuses with `NOT_A_BITRIX_TURN`, and that includes a call that only
carries a bitrix24 route: an operator `POST /tools/invoke` with
`x-openclaw-message-channel: bitrix24` and `x-openclaw-message-to: chat<N>`,
or a cron or subagent run with a bitrix24 `deliveryContext`. The target is
then checked again against the live config: a DM must be in `allowFrom` (and
`dmPolicy` not `disabled`); a group needs `groupPolicy: "allowlist"` and a
`groups` entry; the sender must be a numeric id in `allowFrom` and, in a DM,
own it.

**Who may call it.** Only the agent the `bitrix24` channel routes to, read
from `bindings`: `type` `"route"` (or missing), `match.channel: "bitrix24"`,
and `match.accountId` `"*"`, this account, or omitted (the default account).
No such binding, or bindings naming more than one agent: refused. The account
must be running (its live client, bot id and bot token are used).

**The export service.** One pinned URL, a constant in `src/sheets.ts`:
`POST http://127.0.0.1:8765/exports/stock` (loopback; redirects are errors;
180 s timeout). The bearer token comes from the gateway environment variable
`ONESOFT_MCP_TOKEN`; missing or shorter than 32 characters, the tool refuses
with `EXPORT_NOT_CONFIGURED` and makes no request. This is an outbound request
on loopback only: the plugin still opens no port and registers no route.

**Checks before upload.** The response is capped at 7.5 MiB before it is
parsed. Then: `ok === true`; `file_name` matches
`^[A-Za-z0-9._-]{1,120}\.xlsx$` (no leading dot); `mime_type` is exactly
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
`content_base64` is canonical Base64; the bytes start with `PK\x03\x04` and are
at most 5 MiB; every `summary` field has its exact type (integers, decimal
strings, booleans, `YYYY-MM-DD`), rows never exceed the available total, the
warehouse matches the request, and when the request named an `as_of` the
summary's `as_of` equals it. Two summary counters are optional non-negative
integers, 0 when absent (an older export service does not send them):
`items_without_name` (lines without an item name) and `null_amounts` (lines
whose amount was null upstream).

**Export errors.** A non-200 export response is mapped by the service's own
`code` first (on any status; codes that are not a safe token count as no
code), then by the HTTP status:

| Service `code` or status | Tool `error_code` | Message |
|---|---|---|
| `TOO_LARGE`, or 413 | `EXPORT_TOO_LARGE` | the export is too large for one sheet; ask for one warehouse |
| `UNKNOWN_WAREHOUSE` | `EXPORT_NOT_FOUND` | no warehouse has that code |
| `NAMES_UNAVAILABLE` | `EXPORT_NAMES_UNAVAILABLE` | item names are not loaded on the export service; ask the operator |
| `NOT_CONFIGURED` | `EXPORT_NOT_CONFIGURED` | export service is not configured |
| other 503 | `EXPORT_UNAVAILABLE` | export service is unavailable right now |
| 504 | `EXPORT_TIMEOUT` | export service timed out reading the data |
| 401, 403 | `EXPORT_UNAUTHORIZED` | export service refused the credentials |
| 400, 405, 422 | `EXPORT_BAD_REQUEST` | export service rejected the request |
| anything else, including a 404 with another code or none | `EXPORT_UPSTREAM_ERROR` | export service failed |

`EXPORT_NOT_CONFIGURED` is shared with the local check (token missing or too
short, message `export service not configured`, no request made); the
service's code in the message tells them apart.

**Upload.** `imbot.v2.File.upload` with `{botId, botToken, dialogId, fields:
{name, content, message}}` and a 60 s timeout. The upload is not idempotent,
so it is never repeated when Bitrix may already have processed it: no retry
after a timeout, a transport error, or a bare HTTP 429/503 without a Bitrix
error code (a proxy can answer 503 after the work was done). It is retried
only on an explicit rate-limit code (`QUERY_LIMIT_EXCEEDED`,
`OPERATION_TIME_LIMIT`), which Bitrix sends when it blocked the call before
running it. Other Bitrix calls keep the default: they also retry transport
errors and a bare 429/503. The caption is plain text built only from the
server summary, in English or Georgian (`lang`), for example:
`Stock at Main (WH-01) as of 2026-01-15: 2700 lines, total quantity 12345.678. Source: 1C copy.`
When the export was truncated it adds
`Truncated: <rows> of <total> lines shown. Total quantity of all lines: <total_quantity_all>.`
When `items_without_name` is above 0 it adds `<n> lines have no item name.`
(`1 line has no item name.` for one; Georgian:
`<n> სტრიქონს არ აქვს საქონლის დასახელება.`).

**Confirmed or not.** The file counts as sent only when Bitrix returns a real
message id (a positive integer). Every failed upload is one of two codes:

* `UPLOAD_FAILED`: Bitrix answered with an explicit error code in a JSON body
  that means it rejected the request (any code on a 2xx or 4xx response, such
  as `FILE_TOO_LARGE` or an access error, or a rate-limit code after the
  retries). The file is not in the chat.
* `UPLOAD_UNCONFIRMED`: the file may already be in the chat. A transport
  error, a timeout (also while reading a 200 body), a cancel after the upload
  request started, an HTTP 5xx or 429 without a Bitrix code, a body that
  cannot be read, a 5xx with any other code, or a success response without a
  message id (a file id alone, or a message id of 0, null or ""). The model is
  told not to call the tool again and to ask the user to check the chat.

A cancel before the upload starts is `ABORTED`: nothing was uploaded.

**Result for the model.** Success:
`{ok: true, file_name, rows, total_rows_available, total_quantity,
total_quantity_all, as_of, warehouse_code, warehouse_name, truncated,
items_without_name, null_amounts, message_id}`. Failure:
`{ok: false, error_code, message}`; nothing is claimed as sent. The codes:

| `error_code` | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | the arguments fail the runtime re-validation |
| `TARGET_NOT_ALLOWED` | an argument tried to choose the destination (`dialogId`, `chatId`, `to`, ...) |
| `NOT_A_BITRIX_TURN` | no bitrix24 `deliveryContext`, or no requesting Bitrix24 user on the turn |
| `INVALID_TARGET` | the current conversation is not a numeric DM id or `chat<N>` |
| `UNKNOWN_ACCOUNT` | the turn's account is unknown, or the turn names two accounts |
| `CONFIG_UNAVAILABLE` | no runtime config |
| `AGENT_NOT_RESOLVED` | no bitrix24 route binding, or bindings naming more than one agent |
| `AGENT_NOT_ALLOWED` | the calling agent is not the one bound to the channel |
| `CHANNEL_UNAVAILABLE` | the channel is not configured or is disabled |
| `DM_TARGET_NOT_ALLOWED` | the DM is not in `allowFrom`, or `dmPolicy` is `disabled` |
| `GROUP_TARGET_NOT_ALLOWED` | the chat is not listed in `groups`, or `groupPolicy` is not `allowlist` |
| `SENDER_NOT_ALLOWED` | the sender is not a numeric id in `allowFrom`, or does not own the DM |
| `ACCOUNT_NOT_RUNNING` | the account is not running |
| `ABORTED` | the turn was cancelled before the upload started; nothing was uploaded |
| `EXPORT_*` | the export failed (table above, plus `EXPORT_UNREACHABLE`, `EXPORT_ABORTED`, `EXPORT_INVALID_RESPONSE` and the local size caps as `EXPORT_TOO_LARGE`); nothing was uploaded |
| `UPLOAD_FAILED` | Bitrix24 refused the upload (`<CODE>`); the file was not sent |
| `UPLOAD_UNCONFIRMED` | the upload may already be in the chat; do not send it again |
| `INTERNAL_ERROR` | an unexpected error; the file was not sent |

The tool description tells the model to say "sent" only on `ok: true`, not to
call the tool again after `UPLOAD_UNCONFIRMED`, and to suggest one warehouse
after `EXPORT_TOO_LARGE` instead of retrying.

**Logs.** One line per call: on success (info)
`[bitrix24] sheet sent kind=stock dialog=<id> rows=<n> bytes=<n> file=<name> messageId=<id>`;
on `UPLOAD_UNCONFIRMED` (warn) `[bitrix24] sheet unconfirmed code=UPLOAD_UNCONFIRMED`;
on any other failure (warn) `[bitrix24] sheet not sent code=<CODE>`. The
token, the export URL, the file bytes and row data are never logged.

**Enabling it.** The tool is declared in `openclaw.plugin.json`
(`contracts.tools`, with `toolMetadata` `optional: true`), so no agent sees it
until its tool policy names it, for example `alsoAllow: ["bitrix24_send_sheet"]`
on the Bitrix24 agent. A `deny` entry that covers plugin tools (such as
`group:plugins`) blocks it, because deny wins over allow. The gateway needs
`ONESOFT_MCP_TOKEN` in its environment and the export service listening on
`127.0.0.1:8765` in the same network namespace.

## Customer-calls data (`bitrix24_pulse_data`)

An optional, **read-only** agent tool for a "business pulse" skill, built for a
portal whose CRM deals are logged customer calls (one pipeline; in-progress
stages, one won stage, and failure stages that are really call topics; no
amounts). It returns one section, `calls`: calls created and closed in the last
7 days against the 7 before, calls waiting now (count, oldest in days, how many
over 2 days), the median hours to close over the last 7 days, the call topics
(closing stages) of the last 7 days, and closed calls per pipeline.

* **Separate webhook, separate client.** `channels.bitrix24.crmWebhookUrl`
  (optional SecretInput, `${BITRIX24_CRM_WEBHOOK_URL}`), created by a
  low-privilege service user with scope `crm` only and a CRM role that can only
  read deals. `src/crm-client.ts` allows exactly `crm.item.list`,
  `crm.category.list` and `crm.status.list`; anything else (every write,
  `batch`, tasks, calendar, `user.get`) throws `METHOD_NOT_ALLOWED`
  synchronously, before any request. The imbot client and its allowlist are
  unchanged.
* **Counts only.** Deals are read with `id`, `categoryId`, `stageId`,
  `createdTime` and `movedTime`; never a title, amount, person or contact.
* **Limits.** At most 2 request starts per second per call, 60 s per request,
  one retry on `QUERY_LIMIT_EXCEEDED` / `OPERATION_TIME_LIMIT`, 50 rows per
  page, at most 40 pages per listing (`meta.truncated` when hit). A normal run
  is about 10 requests.
* **Caller.** Only the agent the bitrix24 channel routes to (`bindings`), taken
  from the host-set tool context `agentId`. Any other agent or a call without
  an agent id: `NOT_BITRIX_AGENT`, no request.
* **Failures.** Unset webhook, disabled channel or a URL outside
  `portalDomain`: `NOT_CONFIGURED`, no request. No visible deal pipeline
  (Bitrix answers empty lists, not errors, without read rights):
  `NO_CRM_ACCESS`, never "zero calls". When every requested section failed the
  call is `ALL_SECTIONS_UNAVAILABLE` with the per-section codes.
* **Windows** are whole days in Asia/Tbilisi (the portal this was built for):
  last 7 = today-6 .. today, prior 7 = today-13 .. today-7.
* **Enabling it.** Set `crmWebhookUrl` and add `bitrix24_pulse_data` to the
  agent's `alsoAllow` (the tool is `optional: true`, `sideEffecting: false`).

## Testing

Run tests locally:

```bash
npm test          # vitest: 806 tests
npm run typecheck # tsc --noEmit
```

Tests include:
- Unit tests for config, client, secrets, inbound/outbound handlers
- The sheet tool and the export fetch (`test/tools.test.ts`,
  `test/sheets.test.ts`): argument, target and missing-sender refusals, agent
  resolution from bindings, the export error mapping, every
  response-validation rejection, refused vs unconfirmed uploads (also through
  the real client: no retry of a bare 429/503, a timeout or a cancel
  mid-upload), captions, log hygiene, registration, and the loop guard for the
  bot's own file message
- Hard guard, mention detection, reply degradation, poller pacing and what a
  stop in the middle of a batch acknowledges (`test/guard.test.ts`,
  `test/mentions.test.ts`, `test/delivery.test.ts`, `test/poller.test.ts`)
- Channel restart on a config change (`test/reload.test.ts`): the
  `reload.configPrefixes` declaration, and start, stop, start through the
  gateway adapter against the fake server (offset resumed, one poll loop, the
  running-account runtime unset in between, a stop mid-batch)
- Group chats, sessions and command hand-off through the real SDK ingress and
  router (`test/groups.test.ts`), with synthetic fixtures that match real v2
  DM, group and join events (`test/fixtures.ts`)
- Integration test with a fake Bitrix24 server (`test/fake-bitrix/server.mjs`)
- No network egress; all tests run offline

### Test-only escape hatch

`allowInsecureHttpForTests: true` permits plain `http://` webhook URLs for offline testing with the fake server. It is **double-gated**:
1. Config flag must be `true`, AND
2. Process must have `NODE_ENV=test` OR `BITRIX24_ALLOW_INSECURE_HTTP=1`

**Never enable in production.**

## Smoke Test Checklist

After deployment:

- [ ] Plugin loads: `docker compose logs openclaw-gateway | grep bitrix24`
- [ ] Account starts when `enabled: true`: check logs for bot registration
- [ ] DM from allowed user arrives and generates response
- [ ] DM from non-allowed user is blocked (logged at debug)
- [ ] Group chat message is ignored (info log with a reason) unless `groupPolicy` is `allowlist`, the chat is listed in `groups`, the bot is @mentioned and the sender is in `allowFrom`
- [ ] `/status` and other card/button replies arrive as plain text
- [ ] Bot does not echo its own messages
- [ ] Markdown formatting works (BBCode conversion)
- [ ] Long messages are chunked correctly (4000-char limit)
- [ ] If the sheet tool is enabled: a stock sheet request in an allowed DM posts a file from the bot, the log shows one `sheet sent` line, and the bot's own file message is not answered

## Troubleshooting

**Plugin not loading**
- Check `plugins.load.paths` points to correct volume mount
- Verify volume exists: `docker volume ls | grep openclaw-plugins`
- Check ownership: run `sync-plugin-to-volume.sh` again

**Account not starting**
- Check `channels.bitrix24.enabled` is `true`
- Verify both `${BITRIX24_WEBHOOK_URL}` and `${BITRIX24_BOT_TOKEN}` resolve
- Check `portalDomain` matches webhook URL host
- Review logs: `docker compose logs openclaw-gateway`

**Bot registered but no messages arrive**
- Verify `allowFrom` includes the sender's Bitrix24 user ID
- Check poll interval: maybe increase `poll.idleMs`/`poll.activeMs` temporarily
- Look for rate limit errors in logs

**Bot silent in a group chat**
- Check `groupPolicy` is `"allowlist"` and the chat's dialog id (`chat<N>`) is a key of `groups`
- The message must @mention the bot, and the sender must be in `allowFrom`
- Look for `ignored group message ... reason=` or `(hard guard) ... reason=` info lines in the logs

**Messages not sending**
- Check Bitrix24 API response in logs
- Verify bot token is correct
- Confirm webhook URL is valid and accessible

## Named Volume Note (Windows)

On Windows, Docker Desktop's default 9p/drvfs bind mounts cannot express POSIX ownership and modes that OpenClaw's plugin loader requires. That's why this plugin uses a **named volume** (`openclaw-plugins`) managed via `sync-plugin-to-volume.sh`.

If you see "plugin refused to load" or similar errors, re-run the sync script to fix permissions.

## License

MIT License. See [LICENSE](LICENSE) file for details.

## Contributing

Contributions welcome! Please:
1. Run tests: `npm test`
2. Run typecheck: `npm run typecheck`
3. Follow existing code style
4. Add tests for new features

## Acknowledgments

This plugin was developed as a secure alternative to Path A (webhook receiver) after security review identified webhook forgery risks. It demonstrates that Bitrix24 integration is possible without an inbound HTTP surface.
