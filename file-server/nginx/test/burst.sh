#!/bin/sh
BASE="http://proxy"
LIMITED="$BASE/api/v3/atproto/conversations"
STATUS='%{http_code} '
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

client() {
  echo "X-Forwarded-For: 203.0.113.$1"
}

# Each scenario uses its own client address and sends all of its requests from one curl
# process: the bucket refills with time, so a result must not depend on the gap between
# two processes.
creations() {
  from="$1"
  count="$2"
  shift 2
  while [ "$count" -gt 0 ]; do
    set -- -o /dev/null "$LIMITED" "$@"
    count=$((count - 1))
  done
  curl -s -w "$STATUS" -X POST -H "$(client "$from")" "$@"
}

refusal() {
  from="$1"
  origin="$2"
  creations "$from" 11 --next -s -X POST -H "$(client "$from")" -H "Origin: $origin" \
    -D "$WORK/headers" -o "$WORK/body" "$LIMITED" >/dev/null
  tr -d '\r' <"$WORK/headers" >"$WORK/refusal"
}

refusal_status() {
  head -1 "$WORK/refusal" | cut -d' ' -f2
}

header() {
  grep -i "^$1:" "$WORK/refusal" | cut -d' ' -f2-
}

echo "burst=$(creations 10 12)"
echo "trailing_slash=$(creations 11 11 -o /dev/null "$LIMITED/")"
echo "upper_case=$(creations 12 11 -o /dev/null "$BASE/API/V3/ATPROTO/CONVERSATIONS")"
echo "other_client=$(creations 13 12 --next -s -w "$STATUS" -X POST -H "$(client 14)" -o /dev/null "$LIMITED")"
echo "get=$(creations 15 12 --next -s -w "$STATUS" -H "$(client 15)" -o /dev/null "$LIMITED")"
echo "options=$(creations 16 12 --next -s -w "$STATUS" -X OPTIONS -H "$(client 16)" -o /dev/null "$LIMITED")"

set --
votes=15
while [ "$votes" -gt 0 ]; do
  set -- "$@" -o /dev/null "$BASE/api/v3/embed/vote"
  votes=$((votes - 1))
done
echo "other_route=$(creations 17 12 "$@")"

refusal 18 https://blacksky.community
echo "refusal_status=$(refusal_status)"
echo "refusal_type=$(header content-type)"
echo "refusal_retry=$(header retry-after)"
echo "refusal_origin=$(header access-control-allow-origin)"
echo "refusal_vary=$(header vary)"
echo "refusal_body=$(cat "$WORK/body")"

refusal 19 https://blacksky.community.example
echo "suffixed_origin=$(refusal_status) $(header access-control-allow-origin)"

refusal 20 https://notblacksky.community
echo "prefixed_origin=$(refusal_status) $(header access-control-allow-origin)"
