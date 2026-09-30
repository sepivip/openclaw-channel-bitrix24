# Bitrix24 channel for OpenClaw

Connects an OpenClaw agent to a Bitrix24 portal as an `imbot.v2` chat bot.
People on the portal talk to the agent in direct messages and, if you allow
it, in group chats you approve one by one.

The plugin runs in **fetch mode**: it polls `imbot.v2.Event.get` with an
outbound HTTPS call to your portal's inbound-webhook URL. It opens no port and
registers no HTTP route, so there is no public endpoint to find, forge or keep
patched.

- Requires OpenClaw **2026.9.4** or later. Tested on 2026.9.4, 2026.9.6 and
  2026.9.7.
- No runtime dependencies: the plugin imports only `openclaw/plugin-sdk/*` and
  Node built-ins.
- Closed by default: nothing starts until you enable the channel, only users
  you list get answers, and group chats are off.

## Install

```bash
openclaw plugins install clawhub:@sepivip/openclaw-channel-bitrix24
```

OpenClaw first shows ClawHub's security audit for the release and the
plugin's declared capabilities (one channel and two optional tools), and asks
you to accept them. In a script, review them first and add
`--accept-capabilities`; without it a non-interactive install stops at this
step and installs nothing.

This installs and enables the plugin (its id is `bitrix24`). The channel itself
stays off until you configure it below. If you installed from a separate shell
while a gateway was running, restart the gateway so it loads the plugin.

Check that it loaded:

```bash
openclaw plugins inspect bitrix24 --runtime --json
# expect "status": "loaded" and "compatibility": []
```

Running OpenClaw in Docker and prefer to build from source? See
[Manual install into a Docker named volume](docs/manual-install.md).

## Set up Bitrix24

1. **Choose who owns the webhook.** A Bitrix24 inbound webhook acts with the
   rights of the user who creates it. A dedicated user with no admin rights is
   the safest owner.
2. **Create an inbound webhook** as that user: *Applications → Developer
   resources → Other → Inbound webhook*. Grant only the **`imbot`** scope. Copy
   the URL. It looks like `https://<portal>/rest/<userId>/<token>/`. Treat it
   as a password: anyone holding it can act as that user within the scope.
3. **Generate a bot token**, a random string of up to 40 characters, for
   example with `openssl rand -hex 16`. The plugin registers the bot with it
   and sends it on every bot call.
4. **Find the user ids** of the people who may use the bot. A user's profile
   URL ends in `/company/personal/user/<id>/`.

## Configure

Put the two secrets in the gateway's environment, for example in the `.env`
file of your Docker Compose stack:

```bash
BITRIX24_WEBHOOK_URL=https://your-portal.bitrix24.com/rest/1/xxxxxxxxxxxxxxxx/
BITRIX24_BOT_TOKEN=replace-with-your-random-token
```

Configure the channel. The secrets are referenced as SecretRefs, so their
values never land in `openclaw.json`:

```bash
openclaw config set --batch-json '[
  {"path": "channels.bitrix24.enabled", "value": false},
  {"path": "channels.bitrix24.webhookUrl", "value": {"source": "env", "provider": "default", "id": "BITRIX24_WEBHOOK_URL"}},
  {"path": "channels.bitrix24.botToken", "value": {"source": "env", "provider": "default", "id": "BITRIX24_BOT_TOKEN"}},
  {"path": "channels.bitrix24.portalDomain", "value": "your-portal.bitrix24.com"},
  {"path": "channels.bitrix24.dmPolicy", "value": "allowlist"},
  {"path": "channels.bitrix24.allowFrom", "value": ["12345"]},
  {"path": "channels.bitrix24.groupPolicy", "value": "disabled"},
  {"path": "channels.bitrix24.bot.name", "value": "Assistant"}
]'
```

`portalDomain` must match the end of the webhook URL's host; the plugin
refuses any other host. `allowFrom` takes numeric Bitrix24 user ids as strings.
An empty list means nobody gets an answer.

**Route the channel to an agent.** Without a binding, Bitrix24 messages go to
your default agent. A dedicated agent with a narrow tool policy is better,
because everyone on `allowFrom` can talk to it. Add an entry like this to the
top-level `bindings` list in `openclaw.json`:

```json5
{ type: "route", agentId: "bitrix24-assistant", match: { channel: "bitrix24", accountId: "*" } }
```

**Enable the channel** when you are ready:

```bash
openclaw config validate
openclaw config set channels.bitrix24.enabled true
```

The channel starts without a gateway restart. The gateway log should show
`imbot.v2.Bot.register ok` with the bot id, then polling. Send the bot a
direct message from a user on `allowFrom`.

## Security model

- **Six Bitrix24 methods, fixed in code.** `imbot.v2.Bot.register`,
  `Bot.update`, `Event.get`, `Chat.Message.send`, `Chat.InputAction.notify` and
  `File.upload` (the last only for the optional sheet tool). Any other method
  name throws before a request is made. All six need only the `imbot` scope.
- **One validated base URL.** The webhook URL must be `https:`, its path must
  be `/rest/<digits>/<token>/`, and its host must end with `portalDomain`.
- **Secrets stay out of logs.** Failures are wrapped before logging. Webhook
  URLs and tokens never appear in log fields; at most a 16-character SHA-256
  fingerprint does.
- **Default deny, enforced by OpenClaw's own ingress.** `dmPolicy` is
  `allowlist` by default and has no `open` value. `allowFrom` accepts numeric
  user ids only.
- **Hard guard before any policy.** Extranet chats, chats with collabers, Open
  Lines and other entity-linked chats, and extranet, connector, bot or
  external-auth senders are refused before config, ingress or any reply. A
  missing safety field on a group counts as unsafe.
- **Loop guard.** The bot's own messages, and messages from any bot, are
  dropped.
- **No media in replies.** A reply is text only. A file can be sent only by
  the optional `bitrix24_send_sheet` tool, and only into the chat of the turn
  that called it.
- **Rate limits.** A token bucket of 1.5 requests per second (burst 20),
  exponential backoff with jitter on rate-limit errors, and a 20 s timeout per
  request.

## Group chats

Off by default. To answer in a group, set `groupPolicy` to `"allowlist"` and
list the chat under `groups` by its dialog id:

```json5
channels: {
  bitrix24: {
    groupPolicy: "allowlist",                          // "disabled" or "allowlist"; there is no "open"
    groups: { "chat123": { requireMention: true } },   // requireMention defaults to true
  },
},
```

In a listed chat, the bot answers only when it is @mentioned **and** the
sender is on `allowFrom`. Everyone in the chat can read its answers, so approve
only chats whose members may see what the agent can see. Each group gets its
own session. Commands still work only for the owners in `commands.allowFrom`,
and in a group they also need the @mention.

When someone adds the bot to a chat, the gateway logs the chat's dialog id, who
added it, the hard-guard verdict and whether the chat is listed. The bot never
answers that event. Unlisted chats are ignored with an info log line.

The full admission order is in [Group chats in detail](docs/group-chats.md).

## Configuration reference

All keys live under `channels.bitrix24`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Nothing polls or registers until this is `true`. |
| `webhookUrl` | SecretInput | | Inbound webhook base URL, `https://<portal>/rest/<userId>/<token>/`. |
| `botToken` | SecretInput | | Your bot token, up to 40 characters. |
| `portalDomain` | string | | The webhook host must end with this, e.g. `example.bitrix24.com`. |
| `dmPolicy` | `"allowlist"` \| `"pairing"` \| `"disabled"` | `"allowlist"` | Who may open a direct conversation. There is no `"open"`. |
| `allowFrom` | string[] | `[]` | Numeric Bitrix24 user ids allowed to talk to the bot, in DMs and groups. |
| `groupPolicy` | `"disabled"` \| `"allowlist"` | `"disabled"` | Whether listed group chats are eligible. |
| `groups` | object | | Eligible chats keyed `chat<N>`: `{ requireMention?: boolean }`, default `true`. |
| `bot.code` | string | `"openclaw_bot"` | The bot's code on the portal. Keep it stable: a new code registers a second bot. |
| `bot.name` | string | `"Assistant"` | Display name. |
| `bot.color` | string | `"PURPLE"` | Avatar colour. |
| `bot.workPosition` | string | `"AI Assistant"` | Subtitle under the name. |
| `poll.idleMs` | integer | `15000` | Poll interval when idle, at least 1000. |
| `poll.activeMs` | integer | `3000` | Poll interval while a conversation is active, at least 500. |
| `crmWebhookUrl` | SecretInput | | Only for the optional `bitrix24_pulse_data` tool. A separate webhook with the `crm` scope. |

A change under `channels.bitrix24` restarts only this channel, not the
gateway. Polling pauses for a moment, the message being answered (if any)
still gets its reply, and polling resumes from the saved offset, so nothing is
skipped or answered twice.

## Replies

Bitrix24 chat understands BB-code, not Markdown. The plugin escapes the
agent's text and converts common Markdown (bold, italics, code, links, bullet
lists) to real BB tags. Long replies are split into messages of at most 4,000
characters.
Cards and buttons that OpenClaw produces, such as `/status`, arrive as plain
text; callback values are never shown.

## Optional tools

The plugin also registers two agent tools. Both are declared optional: no
agent sees them until its tool policy names them, for example
`agents.entries.<agent id>.tools.alsoAllow: ["bitrix24_pulse_data"]`. A `deny` entry that covers plugin tools,
such as `group:plugins`, blocks them. Only the agent the channel is routed to
(through `bindings`) may call either one.

Both were built for one production deployment and carry its assumptions. Read
their pages before enabling them.

- **`bitrix24_send_sheet`** asks a local export service on
  `127.0.0.1:8765` for a server-built `.xlsx` and posts it into the current
  chat. It is useful only if you run a service with the same contract.
  [Contract and error codes](docs/tools/bitrix24_send_sheet.md).
- **`bitrix24_pulse_data`** is read-only. It summarises CRM deals that a
  portal uses as a customer-call log, over whole days in Asia/Tbilisi, through
  a separate `crm`-scope webhook limited in code to three read methods.
  [Details](docs/tools/bitrix24_pulse_data.md).

## Troubleshooting

**Plugin not listed or not loaded.** Run
`openclaw plugins inspect bitrix24 --runtime --json` and read `status` and
`diagnostics`. After installing from a separate shell, restart the gateway.

**Channel does not start.** Check that `channels.bitrix24.enabled` is `true`,
that both environment variables are set in the **gateway's** environment (an
empty value counts as missing), and that `portalDomain` matches the webhook
host. `openclaw config validate` reports secrets that do not resolve.

**Bot registered, but no answers.** The sender's numeric id must be on
`allowFrom`. A direct message from anyone else is logged at warn level as
`Blocked unauthorized bitrix24 sender <id>`.

**Silent in a group chat.** `groupPolicy` must be `"allowlist"`, the chat's
`chat<N>` id must be a key of `groups`, the message must @mention the bot, and
the sender must be on `allowFrom`. Look for `ignored group message ... reason=`
or hard-guard lines in the log.

**Rate-limit errors.** Raise `poll.idleMs` and `poll.activeMs`. The client
already backs off on its own.

## Development

```bash
npm ci            # installs with lifecycle scripts disabled (.npmrc)
npm run build     # tsc -> dist/
npm run typecheck
npm test          # vitest, fully offline
```

The tests cover config, the REST client, secrets, inbound and outbound
handling, the hard guard, mentions, reply degradation, poller pacing, the
channel restart on a config change, group sessions through the real SDK
ingress, both optional tools, and an integration run against a fake Bitrix24
server (`test/fake-bitrix/server.mjs`). They make no network calls.

`allowInsecureHttpForTests: true` allows a plain `http://` webhook URL for the
fake server. It works only when the process also has `NODE_ENV=test` or
`BITRIX24_ALLOW_INSECURE_HTTP=1`. Never set it in production.

Contributions are welcome. Please run the tests and the typecheck, follow the
existing style, and add tests for new behaviour.

## License

MIT. See [LICENSE](LICENSE).
