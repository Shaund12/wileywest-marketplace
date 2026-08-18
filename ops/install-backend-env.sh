#!/usr/bin/env bash
#
# Create /etc/blockdust/backend.env — the root-owned, 0600 file that holds the
# backend's DATABASE_URL. The systemd unit reads it via EnvironmentFile= so the
# credential never lives in a tracked file.
#
#   sudo bash ops/install-backend-env.sh
#
# Then edit the file and replace CHANGE_ME with the real password:
#
#   sudo nano /etc/blockdust/backend.env
#   sudo systemctl restart blockdust-backend
#
# The script refuses to overwrite an existing file — it will tell you so and
# leave the current one untouched.

set -euo pipefail

ENV_DIR=/etc/blockdust
ENV_FILE="${ENV_DIR}/backend.env"

DB_USER="${DB_USER:-hyvedash}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-blockdust}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash ops/install-backend-env.sh" >&2
  exit 1
fi

if [[ -e "${ENV_FILE}" ]]; then
  echo "${ENV_FILE} already exists — leaving it alone." >&2
  echo "Inspect it with:  sudo cat ${ENV_FILE}" >&2
  exit 1
fi

install -d -m 0750 -o root -g root "${ENV_DIR}"

# umask so the file is never briefly world-readable between create and chmod.
( umask 077
  cat > "${ENV_FILE}" <<EOF
# BlockDust backend environment. Root-owned, chmod 0600 — do not copy this
# file into the repository; the connection string used to live in the tracked
# systemd unit, which is what this file exists to prevent.
#
# Replace CHANGE_ME below with the real password, then:
#   sudo systemctl restart blockdust-backend
#
# If the password contains any of  : / ? # [ ] @  it must be percent-encoded
# here (@ becomes %40, / becomes %2F, and so on) or the URL will not parse.

DATABASE_URL=postgresql://${DB_USER}:CHANGE_ME@${DB_HOST}:${DB_PORT}/${DB_NAME}
EOF
)

chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

echo "Created ${ENV_FILE}"
ls -l "${ENV_FILE}"

cat <<EOF

Next:
  1. sudo nano ${ENV_FILE}          # replace CHANGE_ME
  2. sudo systemctl restart blockdust-backend
  3. curl -s 'localhost:8787/api/health?format=json'   # expect "db":true

If the backend fails to start, check:
  sudo journalctl -u blockdust-backend -n 30 --no-pager
EOF
