#!/usr/bin/env sh
# Container entrypoint — reproduces the Heroku Procfile `release` phase before the
# web process starts, so a container host (App Runner/ECS) gets the same guarantees:
#
#   release: npm run deploy:migrate && npm run health:configcheck
#   web:     node src/index.js   (passed as CMD → "$@")
#
# Both steps are toggleable so the partner can, if they prefer, run migrations as a
# one-off task instead of on every instance start:
#   RUN_MIGRATIONS=0    skip `prisma migrate deploy`
#   RUN_CONFIGCHECK=0   skip the deploy config gate (NOT recommended)
set -eu

if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  echo "[entrypoint] prisma migrate deploy…"
  npm run deploy:migrate
else
  echo "[entrypoint] RUN_MIGRATIONS=0 — skipping migrations"
fi

if [ "${RUN_CONFIGCHECK:-1}" = "1" ]; then
  echo "[entrypoint] health:configcheck (deploy gate)…"
  npm run health:configcheck
else
  echo "[entrypoint] RUN_CONFIGCHECK=0 — skipping config gate"
fi

echo "[entrypoint] starting web process: $*"
exec "$@"
