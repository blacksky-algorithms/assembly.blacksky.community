#!/bin/sh
set --
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ "$#" -gt 0 ] && set -- "$@" --next
  set -- "$@" -s -w '%{http_code} ' -X POST -H "X-Forwarded-For: 203.0.113.$i" \
    -o /dev/null http://proxy/api/v3/atproto/conversations
done
echo "burst=$(curl "$@")"
