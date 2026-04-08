#!/bin/sh
# Copy default presets to the data volume if presets.json doesn't exist yet.
# This ensures first-run in Portainer (or any Docker setup) gets the defaults.
if [ ! -f /app/data/presets.json ]; then
  echo "First run: copying default presets to data volume..."
  cp -r /app/data-defaults/* /app/data/ 2>/dev/null || true
fi

exec "$@"
