#!/bin/bash
# REE.app process entry. Bash 3.2 compatible for macOS /bin/bash.
# Starts the checkout's Investigation Studio on loopback, then opens the
# WebKit window when REEWindow has been compiled. Smoke mode checks the page
# and exits. This script does not install software or contact the network.

set -eu

bundle_root="$(cd "$(dirname "$0")/.." && pwd)"
resources="$bundle_root/Resources"
window_bin="$bundle_root/MacOS/REEWindow"

alert() {
  printf '%s\n' "$1" >&2
  if [ "$(uname -s)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    message=$(printf '%s' "$1" | tr '\n' ' ')
    osascript -e "display alert \"REE\" message \"$message\" as critical" >/dev/null 2>&1 || true
  fi
}

fail() {
  alert "$1"
  exit 2
}

resolve_checkout() {
  if [ -n "${REE_HOME:-}" ] && [ -f "$REE_HOME/ree.mjs" ]; then
    printf '%s\n' "$REE_HOME"
    return 0
  fi
  if [ -f "$resources/checkout.path" ]; then
    recorded=$(tr -d '[:space:]' <"$resources/checkout.path")
    if [ -n "$recorded" ] && [ -f "$recorded/ree.mjs" ]; then
      printf '%s\n' "$recorded"
      return 0
    fi
  fi
  return 1
}

resolve_node() {
  if [ -n "${REE_NODE:-}" ]; then
    if [ -x "$REE_NODE" ]; then
      printf '%s\n' "$REE_NODE"
      return 0
    fi
    return 1
  fi
  if [ -f "$resources/node.path" ]; then
    recorded=$(tr -d '[:space:]' <"$resources/node.path")
    if [ -n "$recorded" ] && [ -x "$recorded" ]; then
      printf '%s\n' "$recorded"
      return 0
    fi
  fi
  if [ "${REE_APP_SKIP_LOGIN_SHELL:-}" != "1" ] && [ -x /bin/zsh ]; then
    found=$(/bin/zsh -lc 'command -v node' 2>/dev/null || true)
    if [ -n "$found" ] && [ -x "$found" ]; then
      printf '%s\n' "$found"
      return 0
    fi
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

instance_file="${REE_APP_INSTANCE:-$HOME/Library/Application Support/REE/app-instance.json}"
instance_dir="$(dirname "$instance_file")"
lockdir="${instance_file}.lock"
mkdir -p "$instance_dir"

read_instance() {
  instance_pid=""
  instance_server=""
  instance_url=""
  if [ ! -f "$instance_file" ]; then
    return 0
  fi
  instance_pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$instance_file" | head -n 1)
  instance_server=$(sed -n 's/.*"server_pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$instance_file" | head -n 1)
  instance_url=$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$instance_file" | head -n 1)
}

stop_pid() {
  target="$1"
  if [ -z "$target" ] || [ "$target" = "0" ]; then
    return 0
  fi
  if ! kill -0 "$target" 2>/dev/null; then
    return 0
  fi
  kill -TERM -- "-$target" 2>/dev/null || kill -TERM "$target" 2>/dev/null || true
  sleep 0.2
  kill -KILL -- "-$target" 2>/dev/null || kill -KILL "$target" 2>/dev/null || true
}

focus_pid() {
  if [ "$(uname -s)" != "Darwin" ] || ! command -v osascript >/dev/null 2>&1; then
    return 0
  fi
  osascript -e "tell application \"System Events\" to set frontmost of the first process whose unix id is $1 to true" >/dev/null 2>&1 || true
}

read_instance
if [ -n "$instance_pid" ] && kill -0 "$instance_pid" 2>/dev/null; then
  if [ -n "$instance_url" ]; then
    printf 'REE is already running: %s\n' "$instance_url"
    focus_pid "$instance_pid"
  else
    printf 'REE is already starting.\n'
  fi
  exit 0
fi

if [ -n "$instance_server" ]; then
  stop_pid "$instance_server"
fi
rm -rf "$lockdir"
if ! mkdir "$lockdir" 2>/dev/null; then
  read_instance
  if [ -n "$instance_pid" ] && kill -0 "$instance_pid" 2>/dev/null; then
    printf 'REE is already running: %s\n' "$instance_url"
    exit 0
  fi
  fail "REE could not take its single-instance lock at $lockdir."
fi

hold_lock=1
server_pid=""
fifo_dir=""
err_file=""
keep_server=0

write_instance() {
  printf '{"pid":%s,"server_pid":%s,"url":"%s"}\n' "$$" "${server_pid:-0}" "${1:-}" >"$instance_file"
}

cleanup() {
  status=$?
  trap - EXIT
  if [ "${keep_server:-0}" = "1" ]; then
    exit "$status"
  fi
  if [ -n "${server_pid:-}" ]; then
    stop_pid "$server_pid"
  fi
  if [ "${hold_lock:-0}" = "1" ]; then
    read_instance
    if [ ! -f "$instance_file" ] || [ "$instance_pid" = "$$" ]; then
      rm -f "$instance_file"
    fi
    rm -rf "$lockdir"
  fi
  if [ -n "${fifo_dir:-}" ]; then
    rm -rf "$fifo_dir"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

if ! checkout=$(resolve_checkout); then
  fail "REE could not find the checkout recorded in this app. From that checkout, run: node ree.mjs app build"
fi
if ! node_bin=$(resolve_node); then
  fail "REE could not find Node.js. Install the version in .nvmrc (Node 24.18.0), then from the REE checkout run: nvm use && node ree.mjs app build && node ree.mjs app install"
fi

write_instance ""
fifo_dir=$(mktemp -d "${TMPDIR:-/tmp}/ree-studio.XXXXXX")
fifo="$fifo_dir/studio"
err_file="$fifo_dir/stderr"
mkfifo "$fifo"

args=("$node_bin" "$checkout/ree.mjs" studio --json)
if [ -n "${REE_APP_DATA:-}" ]; then
  args+=(--data "$REE_APP_DATA")
fi
set -m || true
"${args[@]}" >"$fifo" 2>"$err_file" &
server_pid=$!
set +m || true

line=""
if ! read -t 20 -r line <"$fifo"; then
  printf '%s\n' "REE could not start the Investigation Studio." >&2
  if [ -s "$err_file" ]; then
    cat "$err_file" >&2
  fi
  exit 1
fi

case "$line" in
*"\"url\":\"http://127.0.0.1:"* | *"\"url\":\"http://localhost:"*) ;;
*)
  printf '%s\n' "REE studio returned an unexpected address." "$line" >&2
  if [ -s "$err_file" ]; then
    cat "$err_file" >&2
  fi
  exit 1
  ;;
esac

url=$(printf '%s\n' "$line" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
write_instance "$url"

if [ "${REE_APP_SMOKE:-}" = "1" ]; then
  if ! "$node_bin" -e 'const url = process.argv[1]; fetch(url).then(async (response) => { const text = await response.text(); if (!response.ok || !text.includes("Investigation Studio")) process.exit(1); }).catch(() => process.exit(1));' "$url"; then
    printf '%s\n' "REE smoke check could not read the local studio page." >&2
    exit 1
  fi
  printf 'REE smoke ok: %s\n' "$url"
  exit 0
fi

printf 'REE Investigation Studio\n'
printf 'Open this local address: %s\n' "$url"
printf 'Loopback only. No account and no upload.\n'

if [ "${REE_APP_OPEN:-1}" = "0" ]; then
  wait "$server_pid" || true
  exit 0
fi

if [ -x "$window_bin" ]; then
  export REE_SERVER_PID="$server_pid"
  export REE_STUDIO_URL="$url"
  keep_server=1
  trap - EXIT
  trap - TERM INT
  if ! exec "$window_bin"; then
    keep_server=0
    trap cleanup EXIT
    fail "REE could not open its window at $window_bin."
  fi
fi

printf '%s\n' "REE built this bundle without the WebKit window. Opening the studio in the default browser. Quit with Ctrl+C." >&2
if [ "$(uname -s)" = "Darwin" ] && command -v open >/dev/null 2>&1; then
  open "$url" || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
fi
wait "$server_pid" || true
exit 0
