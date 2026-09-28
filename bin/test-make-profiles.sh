#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT/Makefile" "$WORK/Makefile"
FAILURES=0

profiles() {
  local goal="$1" env_file="$2" postgres="$3" local_services="$4"
  {
    echo "TAG=check"
    [ "$postgres" != "unset" ] && echo "POSTGRES_DOCKER=$postgres"
    [ "$local_services" != "unset" ] && echo "LOCAL_SERVICES_DOCKER=$local_services"
  } >"$WORK/$env_file"
  (cd "$WORK" && make -n $goal start 2>/dev/null) |
    grep '^docker compose' |
    grep -o -- '--profile [a-z-]*' |
    tr '\n' ' '
}

check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" == "$expected" ]; then
    echo "ok - $name"
    return
  fi
  echo "not ok - $name"
  echo "  expected: '$expected'"
  echo "  actual:   '$actual'"
  FAILURES=$((FAILURES + 1))
}

BOTH="--profile postgres --profile local-services "
for target in "PROD prod.env" " .env"; do
  goal="${target% *}"
  env_file="${target#* }"
  label="${goal:-default}"
  check "$label: both false" "$(profiles "$goal" "$env_file" false false)" ""
  check "$label: postgres false" "$(profiles "$goal" "$env_file" false true)" "--profile local-services "
  check "$label: local services false" "$(profiles "$goal" "$env_file" true false)" "--profile postgres "
  check "$label: upper case False" "$(profiles "$goal" "$env_file" False FALSE)" ""
  check "$label: both true" "$(profiles "$goal" "$env_file" true true)" "$BOTH"
  check "$label: both absent" "$(profiles "$goal" "$env_file" unset unset)" "$BOTH"
done

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failed"
  exit 1
fi
echo "all passed"
