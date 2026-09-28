#!/bin/bash
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONTEXT="$(cd "$HERE/../.." && pwd)"
ID="nginx-proxy-test-$$"
IMAGE="$ID:latest"
PRIVATE_NET="$ID-private"
PUBLIC_NET="$ID-public"
ELEVEN_THEN_REFUSED="200 200 200 200 200 200 200 200 200 200 200 429 "
FIFTEEN_PASSED="200 200 200 200 200 200 200 200 200 200 200 200 200 200 200 "
CHAIN="X-Forwarded-For: 192.0.2.1, 203.0.113.7"
REFUSAL_BODY='{"error":"polis_err_atproto_conversation_rate_limited","message":"polis_err_atproto_conversation_rate_limited","status":429}'
FAILURES=0

cleanup() {
  docker rm -f "$ID-proxy" "$ID-custom" "$ID-upstream" >/dev/null 2>&1
  docker network rm "$PRIVATE_NET" "$PUBLIC_NET" >/dev/null 2>&1
  docker rmi "$IMAGE" >/dev/null 2>&1
}
trap cleanup EXIT

check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" == "$expected" ]; then
    echo "ok - $name"
    return
  fi
  echo "not ok - $name"
  echo "  expected: $expected"
  echo "  actual:   $actual"
  FAILURES=$((FAILURES + 1))
}

check_match() {
  local name="$1" actual="$2" pattern="$3"
  if [[ "$actual" =~ $pattern ]]; then
    echo "ok - $name"
    return
  fi
  echo "not ok - $name"
  echo "  pattern: $pattern"
  echo "  actual:  $actual"
  FAILURES=$((FAILURES + 1))
}

from() {
  local network="$1"
  shift
  docker run --rm --network "$network" -v "$HERE:/test:ro" "$IMAGE" "$@"
}

field() {
  echo "$1" | sed -n "s/^$2=//p"
}

docker build -q -t "$IMAGE" -f "$CONTEXT/nginx.Dockerfile" "$CONTEXT" >/dev/null || exit 1
docker network create "$PRIVATE_NET" >/dev/null || exit 1
docker network create --subnet 198.51.100.0/24 "$PUBLIC_NET" >/dev/null || exit 1

docker run -d --name "$ID-upstream" --network "$PRIVATE_NET" \
  --network-alias server --network-alias client-participation-alpha \
  -v "$HERE/stub.conf:/etc/nginx/conf.d/default.conf:ro" \
  docker.io/nginx:1.21.5-alpine >/dev/null || exit 1

docker run -d --name "$ID-proxy" --network "$PRIVATE_NET" --network-alias proxy \
  -e API_SERVER_PORT=5000 "$IMAGE" >/dev/null || exit 1
docker network connect --alias proxy "$PUBLIC_NET" "$ID-proxy" || exit 1

docker run -d --name "$ID-custom" --network "$PRIVATE_NET" --network-alias custom \
  -e API_SERVER_PORT=5000 -e TRUSTED_PROXIES=198.51.100.0/24 "$IMAGE" >/dev/null || exit 1
docker network connect --alias custom "$PUBLIC_NET" "$ID-custom" || exit 1

READY="no"
ATTEMPTS=30
while [ "$ATTEMPTS" -gt 0 ]; do
  if from "$PRIVATE_NET" curl -s -f -o /dev/null --max-time 2 http://proxy/api/v3/ready; then
    READY="yes"
    break
  fi
  ATTEMPTS=$((ATTEMPTS - 1))
  sleep 1
done
check "proxy answers" "$READY" "yes"

docker exec "$ID-proxy" nginx -t >/dev/null 2>&1
check "nginx -t accepts the rendered configuration" "$?" "0"

check_match "client address replaces a forwarded chain from a private peer" \
  "$(from "$PRIVATE_NET" curl -s -H "$CHAIN" http://proxy/api/v3/echo)" \
  '^xff=\[203\.0\.113\.7\] '

check_match "trusted addresses at the end of a forwarded chain are skipped" \
  "$(from "$PRIVATE_NET" curl -s -H 'X-Forwarded-For: 203.0.113.7, 10.1.2.3' http://proxy/api/v3/echo)" \
  '^xff=\[203\.0\.113\.7\] '

check_match "peer address is passed when no forwarded header arrives" \
  "$(from "$PRIVATE_NET" curl -s http://proxy/api/v3/echo)" \
  '^xff=\[(::ffff:)?(10|172|192)\.[0-9.]+\] '

check_match "forwarded header from a public peer is ignored" \
  "$(from "$PUBLIC_NET" curl -s -H "$CHAIN" http://proxy/api/v3/echo)" \
  '^xff=\[(::ffff:)?198\.51\.100\.[0-9]+\] '

check_match "TRUSTED_PROXIES replaces the default list" \
  "$(from "$PUBLIC_NET" curl -s --retry 10 --retry-connrefused --retry-delay 1 \
    -H "$CHAIN" http://custom/api/v3/echo)" \
  '^xff=\[203\.0\.113\.7\] '

check_match "prefixed participation route receives the client address" \
  "$(from "$PRIVATE_NET" curl -s -H "$CHAIN" http://proxy/alpha/3abcdefghi)" \
  '^xff=\[203\.0\.113\.7\] .* uri=\[/3abcdefghi\]$'

for path in /oauth-client-metadata.json /auth/callback /_astro/entry.js /3abcdefghi /api/v3/atproto/conversations; do
  check "$path receives the client address" \
    "$(from "$PRIVATE_NET" curl -s -H "$CHAIN" "http://proxy$path" | cut -d' ' -f1,5)" \
    "xff=[203.0.113.7] uri=[$path]"
done

BURST="$(from "$PRIVATE_NET" sh /test/burst.sh)"
check "eleven creations pass and the twelfth is refused" "$(field "$BURST" burst)" "$ELEVEN_THEN_REFUSED"
check "trailing slash is limited" "$(field "$BURST" trailing_slash)" "$ELEVEN_THEN_REFUSED"
check "upper case path is limited" "$(field "$BURST" upper_case)" "$ELEVEN_THEN_REFUSED"
check "another client is not limited" "$(field "$BURST" other_client)" "${ELEVEN_THEN_REFUSED}200 "
check "GET on the same path is not limited" "$(field "$BURST" get)" "${ELEVEN_THEN_REFUSED}200 "
check "OPTIONS on the same path is not limited" "$(field "$BURST" options)" "${ELEVEN_THEN_REFUSED}200 "
check "other POST routes are not limited" "$(field "$BURST" other_route)" "$ELEVEN_THEN_REFUSED$FIFTEEN_PASSED"
check "refusal status" "$(field "$BURST" refusal_status)" "429"
check "refusal content type" "$(field "$BURST" refusal_type)" "application/json"
check "refusal retry hint" "$(field "$BURST" refusal_retry)" "3"
check "refusal is readable by the app origin" "$(field "$BURST" refusal_origin)" "https://blacksky.community"
check "refusal varies by origin" "$(field "$BURST" refusal_vary)" "Origin"
check "refusal body" "$(field "$BURST" refusal_body)" "$REFUSAL_BODY"
check "refusal does not reflect an origin with a suffix" "$(field "$BURST" suffixed_origin)" "429 "
check "refusal does not reflect an origin with a prefix" "$(field "$BURST" prefixed_origin)" "429 "

check "a refusal from the server itself is passed through" \
  "$(from "$PRIVATE_NET" curl -s -w ' %{http_code}' -X POST -H 'X-Forwarded-For: 203.0.113.30' \
    -H 'X-Stub-Status: 429' http://proxy/api/v3/atproto/conversations)" "upstream-429 429"

check "a public peer cannot escape the limit with forwarded headers" \
  "$(field "$(from "$PUBLIC_NET" sh /test/spoof.sh)" burst)" "$ELEVEN_THEN_REFUSED"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failed"
  exit 1
fi
echo "all passed"
