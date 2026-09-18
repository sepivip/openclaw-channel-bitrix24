# openclaw-channel-bitrix24

An OpenClaw **channel plugin** that bridges a Bitrix24 portal's `imbot.v2` chat bot to an OpenClaw agent, in **fetch mode** (Path B): the plugin polls `imbot.v2.Event.get` outbound over the portal's inbound-webhook URL.

**There is no inbound HTTP surface.** No gateway HTTP route, no express, no listener, no published port, no tunnel, no DNS. Webhook forgery is eliminated by construction.

Target runtime: `ghcr.io/openclaw/openclaw:2026.9.4` or later.

## Path A vs Path B

- **Path A** (rejected): Bitrix24 posts events to a public webhook endpoint. Risk: webhook forgery without a verifiable signature.
- **Path B** (this plugin): OpenClaw polls Bitrix24's event queue via `imbot.v2.Event.get`. No inbound HTTP, no forgery surface.

This is a **community plugin** implementing Path B after Path A was rejected for security concerns.

## Security Properties

* **Hardcoded method allowlist**: exactly five methods allowed:
  - `imbot.v2.Bot.register`
  - `imbot.v2.Bot.update`
  - `imbot.v2.Event.get`
  - `imbot.v2.Chat.Message.send`
  - `imbot.v2.Chat.InputAction.notify`
  
  Any other method name throws synchronously. Scope creep is structurally impossible.

* **One base URL, validated at config load**: `https:` only, path must match `/rest/<digits>/<token>/`, host must end with the configured `portalDomain`.

* **Secrets never reach a logger**: Every HTTP failure is wrapped before logging. Webhook URLs are never log fields; only `sha256(secret).hex.slice(0,16)` fingerprints appear.

* **Default deny, enforced by core**: Per-event admission is decided by OpenClaw SDK ingress. `dmPolicy` defaults to `allowlist`; there is no `"open"` value. `allowFrom` accepts numeric Bitrix user ids only.

* **Groups dropped before ingress**: `groupPolicy` is `disabled`; any non-direct chat is dropped and logged at debug.

* **Loop guard**: `data.message.authorId === botId || data.user.bot === true` ⇒ dropped before ingress.

* **Rate limits**: Token bucket 1.5 req/s, burst 20; exponential backoff with jitter on rate-limit errors; 20s timeout per request.

* **Zero runtime dependencies**: The loaded artefact imports only `openclaw/plugin-sdk/*` and Node built-ins.

## Installation

### 1. Build the plugin

```bash
npm ci
npm run build     # tsc -> dist/*.js
npm test          # optional: 91 tests, no network egress
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
| `groupPolicy` | enum | `"disabled"` only. Group chats out of MVP scope. |
| `bot.code` | string | Bot identifier. Default `"openclaw_bot"`. |
| `bot.name` | string | Display name. Default `"Assistant"`. |
| `bot.color` | string | Bot color. Default `"PURPLE"`. |
| `bot.workPosition` | string | Bot subtitle. Default `"AI Assistant"`. |
| `poll.idleMs` | integer | Poll interval when idle (≥1000ms). Default `15000`. |
| `poll.activeMs` | integer | Poll interval when active (≥500ms). Default `3000`. |

## Testing

Run tests locally:

```bash
npm test          # vitest: 91 tests
npm run typecheck # tsc --noEmit
```

Tests include:
- Unit tests for config, client, secrets, inbound/outbound handlers
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
- [ ] Group chat message is dropped (logged at debug)
- [ ] Bot does not echo its own messages
- [ ] Markdown formatting works (BBCode conversion)
- [ ] Long messages are chunked correctly (4000-char limit)

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
