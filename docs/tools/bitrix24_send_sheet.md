# `bitrix24_send_sheet`

Optional tool, off unless an agent's tool policy allows it. Built for one deployment: it needs a local export service with the contract below. Back to the [README](../../README.md).

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
