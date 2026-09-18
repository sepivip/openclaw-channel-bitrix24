#!/usr/bin/env bash
# Copy the BUILT plugin into a Docker named volume with the ownership and modes
# the OpenClaw load path requires.
#
# OpenClaw refuses to load a plugin directory that is world-writable, and a
# Windows 9p bind mount cannot express POSIX modes, so the artefact lives in a
# named volume that we chown to the image's `node` user (uid/gid 1000) and
# chmod 755/644.
#
# It builds NOTHING. Run `npm run build` first.
#
#   ./scripts/sync-plugin-to-volume.sh --dry-run
#   ./scripts/sync-plugin-to-volume.sh --volume my-plugins --subdir bitrix24

set -euo pipefail

VOLUME="openclaw-plugins"
# Path INSIDE the volume, not a container path. The gateway mounts the volume at
# /opt/plugins:ro, so "bitrix24" becomes /opt/plugins/bitrix24.
# Use "." to place the plugin at the volume root.
SUBDIR="bitrix24"
IMAGE="alpine:3.20"
UID_GID="1000:1000"
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: sync-plugin-to-volume.sh [options]

  --volume NAME     Docker named volume to sync into (default: openclaw-plugins)
  --subdir PATH     Directory INSIDE the volume (default: bitrix24; use "." for the volume root)
  --image IMAGE     Helper image used for the copy (default: alpine:3.20)
  --owner UID:GID   Ownership to apply (default: 1000:1000, the image's `node` user)
  --dry-run         Print what would happen and exit without touching anything
  -h, --help        Show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --volume) VOLUME="$2"; shift 2 ;;
    --subdir|--target) SUBDIR="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --owner) UID_GID="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCES=("dist" "package.json" "openclaw.plugin.json")
MOUNT_POINT="/mnt/plugin"

case "${SUBDIR}" in
  ""|"."|"./") DEST="${MOUNT_POINT}" ;;
  /*) DEST="${MOUNT_POINT}${SUBDIR}" ;;
  *) DEST="${MOUNT_POINT}/${SUBDIR}" ;;
esac

# Never `rm -rf` the mount point itself: clear its contents instead.
if [ "${DEST}" = "${MOUNT_POINT}" ]; then
  CLEAN_CMD="mkdir -p '${DEST}' && find '${DEST}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
else
  CLEAN_CMD="rm -rf '${DEST}' && mkdir -p '${DEST}'"
fi

echo "plugin root : ${ROOT_DIR}"
echo "sources     : ${SOURCES[*]}"
echo "volume      : ${VOLUME}"
echo "subdir      : ${SUBDIR}  -> ${DEST}"
echo "owner       : ${UID_GID}"
echo "helper image: ${IMAGE}"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo
  echo "--- DRY RUN: nothing will be created, copied or changed ---"
  echo "would: docker volume create ${VOLUME}   # if missing"
  echo "would: docker run --rm -v ${VOLUME}:${MOUNT_POINT} ${IMAGE} sh -c '${CLEAN_CMD}'"
  for src in "${SOURCES[@]}"; do
    echo "would: docker cp ${ROOT_DIR}/${src} <helper>:${DEST}/"
  done
  echo "would: chown -R ${UID_GID} ${DEST}"
  echo "would: find ${DEST} -type d -exec chmod 755 {} +"
  echo "would: find ${DEST} -type f -exec chmod 644 {} +"
  echo "would: stat the result"
  exit 0
fi

for src in "${SOURCES[@]}"; do
  if [ ! -e "${ROOT_DIR}/${src}" ]; then
    echo "missing ${ROOT_DIR}/${src} -- run 'npm run build' first" >&2
    exit 1
  fi
done

if ! docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
  echo "creating volume ${VOLUME}"
  docker volume create "${VOLUME}" >/dev/null
fi

HELPER="sync-plugin-$$"
cleanup() { docker rm -f "${HELPER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "${HELPER}" -v "${VOLUME}:${MOUNT_POINT}" "${IMAGE}" sleep 300 >/dev/null

docker exec "${HELPER}" sh -c "${CLEAN_CMD}"

# Git Bash: docker cp needs a native Windows path for the host side.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

for src in "${SOURCES[@]}"; do
  docker cp "$(host_path "${ROOT_DIR}/${src}")" "${HELPER}:${DEST}/"
done

docker exec "${HELPER}" sh -c "
  chown -R ${UID_GID} '${DEST}' &&
  find '${DEST}' -type d -exec chmod 755 {} + &&
  find '${DEST}' -type f -exec chmod 644 {} +
"

echo
echo "--- result ---"
docker exec "${HELPER}" sh -c "
  stat -c '%A %U:%G %n' '${DEST}' &&
  find '${DEST}' -maxdepth 2 -exec stat -c '%A %u:%g %n' {} +
"

echo
echo "synced ${VOLUME} -> ${DEST}"
