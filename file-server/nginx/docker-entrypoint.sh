#!/bin/sh
set -e

# Set default value for API_SERVER_PORT
export API_SERVER_PORT=${API_SERVER_PORT:-5000}
TRUSTED_PROXIES=${TRUSTED_PROXIES:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}

# Replace environment variables in the Nginx config
envsubst '${API_SERVER_PORT}' </etc/nginx/conf.d/default.conf.template >/etc/nginx/conf.d/default.conf

: >/etc/nginx/conf.d/trusted-proxies.conf
for proxy in $(echo "$TRUSTED_PROXIES" | tr ',' ' '); do
  echo "set_real_ip_from $proxy;" >>/etc/nginx/conf.d/trusted-proxies.conf
done

# Execute the original Docker entrypoint with the provided arguments
exec "$@"
