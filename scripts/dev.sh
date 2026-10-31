#!/bin/sh
# Development tasks for tinyprobe for VS Code.
#
#   scripts/dev.sh <command>
#
# Commands:
#   test          Unit tests (Node's test runner, no VS Code needed).
#   integration   Integration tests in a separate VS Code instance, with the tinyprobe binary
#                 built from the sources next to this folder and its test server.
#   check         test + integration: run it before opening a pull request.
#   package       Build tinyprobe-vscode.vsix.
#   install       Package and install the .vsix in your VS Code.
#   sync-shared   Copy the run view shared with tinyprobe-app (web/shared/) into media/shared/,
#                 from ../tinyprobe-app, and record its version in media/shared/VERSION.
#   check-shared  Check that media/shared/ is the copy of the tinyprobe-app version it names (CI).
#
# Environment variables:
#   TINYPROBE_REPO   the tinyprobe repository (default: the folder next to this one that contains Tinyprobe.slnx)
#   TINYPROBE_PATH   the tinyprobe binary (default: the development build of TINYPROBE_REPO)
#   TINYPROBE_PORT   port of the test server (default: 5122)
#   TINYPROBE_APP_REPO  tinyprobe-app, for sync-shared (default: the folder next to this one)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT="${TINYPROBE_PORT:-5122}"
BASE_URL="http://localhost:$PORT"

fail() { echo "dev: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v node > /dev/null || fail "Node.js is needed (22 or newer)."

tinyprobe_repo() {
  if [ -n "${TINYPROBE_REPO:-}" ]; then
    echo "$TINYPROBE_REPO"
    return
  fi
  # Any folder next to this one: the clone may have another name than tinyprobe.
  for candidate in "$ROOT"/../*/; do
    if [ -f "$candidate/Tinyprobe.slnx" ]; then
      (cd "$candidate" && pwd)
      return
    fi
  done
  fail "the tinyprobe repository was not found next to this folder: set TINYPROBE_REPO."
}

unit_tests() {
  step "Unit tests"
  cd "$ROOT" && npm test --silent
}

server_up() { curl -sf -o /dev/null "$BASE_URL/api/public"; }

SERVER_PID=""
stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  pkill -P "$SERVER_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

integration() {
  repo=$(tinyprobe_repo)
  binary="${TINYPROBE_PATH:-}"
  if [ -z "$binary" ]; then
    step "tinyprobe development binary ($repo)"
    "$repo/scripts/dev.sh" install
    binary="$repo/.dev/tinyprobe/tinyprobe"
  fi

  if ! server_up; then
    step "Start the tinyprobe test server on $BASE_URL"
    log=$(mktemp)
    dotnet run --project "$repo/tests/Tinyprobe.RealServer.Tests" --urls "$BASE_URL" > "$log" 2>&1 &
    SERVER_PID=$!
    trap stop_server EXIT INT TERM
    i=0
    until server_up; do
      i=$((i + 1))
      [ "$i" -le 120 ] || { cat "$log"; fail "the test server did not start."; }
      sleep 1
    done
  fi

  step "Integration tests (tinyprobe $("$binary" --version))"
  cd "$ROOT"
  TINYPROBE_PATH="$binary" TINYPROBE_EXAMPLES="$repo/docs" node test/integration/run.js
}

# The run view is shared with tinyprobe-app, which keeps the canonical copy (tinyprobe spec 0017).
SHARED_FILES="run-view.js run-view.css"

sync_shared() {
  app="${TINYPROBE_APP_REPO:-$ROOT/../tinyprobe-app}"
  [ -d "$app/web/shared" ] || fail "tinyprobe-app was not found in $app: set TINYPROBE_APP_REPO."
  for file in $SHARED_FILES; do cp "$app/web/shared/$file" "$ROOT/media/shared/$file"; done
  sed -n 's/.*<VersionPrefix>\(.*\)<\/VersionPrefix>.*/\1/p' "$app/launcher/Tinyprobe.App.csproj" > "$ROOT/media/shared/VERSION"
  step "media/shared/ is now the run view of tinyprobe-app $(cat "$ROOT/media/shared/VERSION")"
}

check_shared() {
  version=$(cat "$ROOT/media/shared/VERSION")
  step "media/shared/ against tinyprobe-app $version"
  for file in $SHARED_FILES; do
    curl -fsSL "https://raw.githubusercontent.com/kikutano/tinyprobe-app/v$version/web/shared/$file" \
      | cmp -s - "$ROOT/media/shared/$file" \
      || fail "media/shared/$file is not the one of tinyprobe-app v$version: change it there, then scripts/dev.sh sync-shared."
  done
}

package() {
  step "Package"
  cd "$ROOT" && npm run package --silent
  ls -1 "$ROOT"/*.vsix
}

case "${1:-}" in
  test) unit_tests ;;
  integration) integration ;;
  check) unit_tests && integration && step "All checks passed" ;;
  package) package ;;
  install) package && code --install-extension "$(ls -1t "$ROOT"/*.vsix | head -1)" --force ;;
  sync-shared) sync_shared ;;
  check-shared) check_shared ;;
  ""|-h|--help|help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) fail "unknown command '$1'. See scripts/dev.sh --help." ;;
esac
