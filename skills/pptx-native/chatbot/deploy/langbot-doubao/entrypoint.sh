#!/bin/bash
set -Eeuo pipefail

secure_dir=/opt/bundle/secure
status_dir=/opt/bundle/status
mkdir -p "$secure_dir" "$status_dir" /app/data
chmod 0700 "$secure_dir" "$status_dir"

if [[ ! -s "$secure_dir/langbot_api_key" ]]; then
    python - <<'PY' > "$secure_dir/langbot_api_key"
import secrets
print(secrets.token_urlsafe(32))
PY
    chmod 0600 "$secure_dir/langbot_api_key"
fi

if [[ ! -s "$secure_dir/onebot_token" ]]; then
    python - <<'PY' > "$secure_dir/onebot_token"
import secrets
print(secrets.token_urlsafe(24))
PY
    chmod 0600 "$secure_dir/onebot_token"
fi

export API__GLOBAL_API_KEY
API__GLOBAL_API_KEY="$(tr -d '\r\n' < "$secure_dir/langbot_api_key")"

pids=()
cleanup() {
    trap - TERM INT EXIT
    for pid in "${pids[@]:-}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup TERM INT EXIT

cd /opt/doubao
SERVER_PORT=8000 node --enable-source-maps --no-node-snapshot dist/index.js >> /app/data/doubao.log 2>&1 &
pids+=("$!")

cd /app
uv run --no-sync -m langbot_plugin.cli.__init__ rt >> /app/data/plugin-runtime.log 2>&1 &
pids+=("$!")

uv run --no-sync main.py >> /app/data/langbot.log 2>&1 &
pids+=("$!")

node /opt/bundle/bootstrap.mjs >> /app/data/bootstrap.log 2>&1 &

wait -n "${pids[@]}"
exit_code=$?
echo "A bundled service exited with status $exit_code" >&2
exit "$exit_code"
