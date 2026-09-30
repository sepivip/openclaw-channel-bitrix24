# Manual install into a Docker named volume

Use this path when the gateway runs in Docker and you want to load the plugin
from a checkout of this repository instead of installing it from ClawHub. Most
installs should use `openclaw plugins install clawhub:@sepivip/openclaw-channel-bitrix24`
(see the [README](../README.md#install)).

OpenClaw refuses to load a plugin whose files have the wrong POSIX owner or
mode. A Windows bind mount (Docker Desktop's 9p/drvfs) cannot express either,
so the built plugin goes into a Docker **named volume** instead.

## 1. Build

```bash
npm ci
npm run build     # tsc -> dist/*.js
npm test          # optional: no network egress
```

## 2. Copy the build into a named volume

```bash
./scripts/sync-plugin-to-volume.sh --volume openclaw-plugins --dry-run   # inspect first
./scripts/sync-plugin-to-volume.sh --volume openclaw-plugins
```

The script copies `dist/`, `package.json` and `openclaw.plugin.json` into
`<volume>/bitrix24`, sets the owner to `1000:1000` (the image's `node` user)
and the modes to `755` for directories and `644` for files.

Always pass `--volume` with the name of the volume your gateway actually
mounts. The default is `openclaw-plugins`; if your stack names it differently
(Compose often prefixes the project name), the default silently creates a new,
unused volume and the gateway keeps loading the old copy.

## 3. Mount the volume

Merge `docker-compose.bitrix24.yml` on top of your main compose file. It mounts
the volume read-only at `/opt/plugins` on the gateway and the CLI container,
and passes `BITRIX24_WEBHOOK_URL` and `BITRIX24_BOT_TOKEN` through from your
`.env`. It adds no service and publishes no port.

```bash
docker compose -f docker-compose.yml -f docker-compose.bitrix24.yml up -d
```

Use the same `-f` pair in every later `docker compose` command for this stack.

## 4. Point OpenClaw at the plugin

```bash
docker compose -f docker-compose.yml -f docker-compose.bitrix24.yml \
  run --rm openclaw-cli config set --batch-json '[
    {"path": "plugins.load.paths", "value": ["/opt/plugins/bitrix24"]},
    {"path": "plugins.entries.bitrix24.enabled", "value": true}
  ]'
```

Then configure and enable the channel as in the README, from
[Configure](../README.md#configure) on. Run the `openclaw` commands shown there
through `docker compose ... run --rm openclaw-cli`.

## Updating

Build the new version, run the sync script again (with the same `--volume`),
then recreate the gateway so it loads the new files. A config change alone does
not reload plugin code.
