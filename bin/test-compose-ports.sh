#!/bin/bash
set -uo pipefail

cd "$(dirname "$0")/.."
export SERVER_ENV_FILE=example.env
PROFILES="--profile postgres --profile local-services"

resolve() {
  docker compose "$@" $PROFILES --env-file example.env config --format json
}

summary() {
  python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
for name in sorted(services):
    ports = sorted(str(p.get("published")) for p in services[name].get("ports", []))
    print(name, services[name].get("restart", "none"), ",".join(ports) or "-")
'
}

logs() {
  python3 -c '
import json, sys
services = json.load(sys.stdin)["services"]
for name in sorted(services):
    logging = services[name].get("logging", {})
    options = logging.get("options", {})
    print(name, logging.get("driver", "none"), options.get("max-size", "-"), options.get("max-file", "-"))
'
}

FAILURES=0
check() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" == "$expected" ]; then
    echo "ok - $name"
    return
  fi
  echo "not ok - $name"
  diff <(echo "$expected") <(echo "$actual")
  FAILURES=$((FAILURES + 1))
}

check "production file publishes only the proxy" "$(resolve -f docker-compose.yml | summary)" \
"client-participation-alpha unless-stopped -
delphi unless-stopped -
dynamodb unless-stopped -
file-server unless-stopped -
math unless-stopped -
minio unless-stopped -
nginx-proxy unless-stopped 443,80
ollama unless-stopped -
postgres always -
server unless-stopped -"

check "production file bounds every container log" "$(resolve -f docker-compose.yml | logs)" \
"client-participation-alpha json-file 50m 5
delphi json-file 50m 5
dynamodb json-file 50m 5
file-server json-file 50m 5
math json-file 50m 5
minio json-file 50m 5
nginx-proxy json-file 50m 5
ollama json-file 50m 5
postgres json-file 50m 5
server json-file 50m 5"

check "development overlay keeps its published ports" \
  "$(resolve -f docker-compose.yml -f docker-compose.dev.yml | summary | awk '{print $1, $3}')" \
"client-participation-alpha 4321
delphi -
dynamodb 8000
dynamodb-admin 8001
file-server 8080
maildev 1025,1080
math 18975
minio 9000,9001
nginx-proxy 443,80
oidc-simulator 3000
ollama 11434
postgres 5432
server 5000,9229"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failed"
  exit 1
fi
echo "all passed"
