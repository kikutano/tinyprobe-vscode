#!/bin/sh
# Development tasks for Foxify for VS Code.
#
#   scripts/dev.sh <command>
#
# Commands:
#   test          Unit tests (Node's test runner, no VS Code needed).
#   integration   Integration tests in a separate VS Code instance, with the foxify binary
#                 built from the sources next to this folder and its test server.
#   check         test + integration: run it before opening a pull request.
#   package       Build foxify-vscode.vsix.
#   install       Package and install the .vsix in your VS Code.
#
# Environment variables:
#   FOXIFY_REPO   the foxify repository (default: ../Foxify, ../foxify or ../tyfapi, whichever exists)
#   FOXIFY_PATH   the foxify binary (default: the development build of FOXIFY_REPO)
#   FOXIFY_PORT   port of the test server (default: 5122)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT="${FOXIFY_PORT:-5122}"
BASE_URL="http://localhost:$PORT"

fail() { echo "dev: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v node > /dev/null || fail "Node.js is needed (22 or newer)."

foxify_repo() {
  if [ -n "${FOXIFY_REPO:-}" ]; then
    echo "$FOXIFY_REPO"
    return
  fi
  for candidate in "$ROOT/../Foxify" "$ROOT/../foxify" "$ROOT/../tyfapi"; do
    if [ -f "$candidate/Foxify.slnx" ]; then
      (cd "$candidate" && pwd)
      return
    fi
  done
  fail "the foxify repository was not found next to this folder: set FOXIFY_REPO."
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
  repo=$(foxify_repo)
  binary="${FOXIFY_PATH:-}"
  if [ -z "$binary" ]; then
    step "foxify development binary ($repo)"
    "$repo/scripts/dev.sh" install
    binary="$repo/.dev/foxify/foxify"
  fi

  if ! server_up; then
    step "Start the Foxify test server on $BASE_URL"
    log=$(mktemp)
    dotnet run --project "$repo/tests/Foxify.RealServer.Tests" --urls "$BASE_URL" > "$log" 2>&1 &
    SERVER_PID=$!
    trap stop_server EXIT INT TERM
    i=0
    until server_up; do
      i=$((i + 1))
      [ "$i" -le 120 ] || { cat "$log"; fail "the test server did not start."; }
      sleep 1
    done
  fi

  step "Integration tests (foxify $("$binary" --version))"
  cd "$ROOT"
  FOXIFY_PATH="$binary" FOXIFY_EXAMPLES="$repo/docs" node test/integration/run.js
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
  ""|-h|--help|help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) fail "unknown command '$1'. See scripts/dev.sh --help." ;;
esac
