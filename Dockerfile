# syntax=docker/dockerfile:1
#
# Slack + Tableau agent — production image for AWS App Runner (or any container host).
#
# Base: Debian slim rather than Alpine. Prisma's engines/driver adapters are
# officially supported on Debian (glibc + OpenSSL) and hit fewer binary-target
# surprises than Alpine's musl. Node 22 matches the Tableau MCP server image.
#
# Process contract preserved from the Heroku Procfile:
#   release: prisma migrate deploy && health:configcheck   → docker-entrypoint.sh
#   web:     node src/index.js                             → CMD
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install deps first for layer caching. Copy only what `npm ci` + the postinstall
# `prisma generate` need (prisma schema + prisma.config.ts) before the app source.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# --omit=dev drops nodemon (the only devDependency). `prisma` and @prisma/client
# are runtime deps, so the postinstall `prisma generate` still runs here.
# Prisma 7's prisma.config.ts eagerly resolves env("DATABASE_URL") on load, so a
# placeholder is required for `prisma generate` (it never connects). This ENV lives
# ONLY in the build stage — the runtime stage does not inherit it, so no bogus URL
# is baked into the shipped image; the real DATABASE_URL is injected at runtime.
ENV NODE_ENV=production
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?sslmode=disable"
RUN npm ci --omit=dev

# App source (certs/, src/, tests/, demo-data/, docs/ — .dockerignore trims the rest).
COPY . .

# ── Runtime image ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# App Runner sets PORT; default to 3000 for local `docker run` parity with Heroku.
ENV PORT=3000

# OpenSSL is needed by Prisma at runtime; slim images omit it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy the built app (incl. generated Prisma client in node_modules) from build.
COPY --from=build /app /app

# Ensure the entrypoint is executable regardless of host file mode, and run as the
# unprivileged `node` user baked into the base image.
RUN chmod +x /app/docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 3000

# The entrypoint runs migrations + the deploy config gate, then execs the CMD.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
