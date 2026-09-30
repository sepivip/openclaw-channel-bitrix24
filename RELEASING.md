# Releasing to ClawHub

The package is `@sepivip/openclaw-channel-bitrix24`. ClawHub only lets the
owner of the `@sepivip` handle publish under that scope. ClawHub signs in with
GitHub.

## One-time setup

```bash
npx --yes clawhub@0.23.3 login    # prints a code and a URL; approve it with the sepivip GitHub account
npx --yes clawhub@0.23.3 whoami   # must show the sepivip handle
```

If `whoami` shows a different handle, the `name` scope in `package.json` has to
match that handle before publishing.

## Each release

1. Bump `version` in `package.json` (and the root entries in
   `package-lock.json`), add a `CHANGELOG.md` entry, and merge that to `main`.
2. From a clean checkout of `main` that matches GitHub:

   ```bash
   git switch main && git pull --ff-only
   scripts/clawhub-publish.sh             # build, typecheck, test, validate, pack, dry run
   ```

   Check the dry run's name, version, compat line, file list and commit.
3. Publish:

   ```bash
   scripts/clawhub-publish.sh --publish
   ```

   A new release stays hidden until ClawHub's automated security checks finish.
   `--wait` (used by the script) waits for that, up to 30 minutes.
4. Confirm it is live:

   ```bash
   npx --yes clawhub@0.23.3 package inspect @sepivip/openclaw-channel-bitrix24
   openclaw plugins search bitrix24
   ```

Every release must come from a commit on GitHub: the script passes the repo and
the exact commit to ClawHub, which records them as the release's source.

## Later

After the first publish, ClawHub can accept releases from GitHub Actions
without a stored token (trusted publishing):

```bash
npx --yes clawhub@0.23.3 package trusted-publisher set @sepivip/openclaw-channel-bitrix24 \
  --repository sepivip/openclaw-channel-bitrix24 --workflow-filename package-publish.yml
```

That also needs a workflow that uses ClawHub's reusable `package-publish.yml`.
It is not set up yet.
