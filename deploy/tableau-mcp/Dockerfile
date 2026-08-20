# syntax=docker/dockerfile:1
#
# Tableau MCP server — deployable image for AWS App Runner.
#
# This packages the OFFICIAL open-source server (github.com/tableau/tableau-mcp)
# rather than vendoring a copy of its source into this repo. We clone a PINNED ref
# and run its own build, so upgrades are a one-line ref bump and we never drift a
# private fork. The upstream ships stdio by default; we default it to the
# streamable-HTTP transport so App Runner can expose it over HTTPS and the Slack
# agent can reach it at  https://<host>/tableau-mcp .
#
# Pin this to a released tag/commit for reproducible builds:
#   docker build --build-arg TABLEAU_MCP_REF=v1.x.y -t tableau-mcp:local .
ARG TABLEAU_MCP_REF=v4.5.1

# ── Build stage: clone + compile the upstream TypeScript ─────────────────────
FROM node:22-bookworm-slim AS build
ARG TABLEAU_MCP_REF
WORKDIR /src
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${TABLEAU_MCP_REF}" https://github.com/tableau/tableau-mcp.git . \
  || (git clone https://github.com/tableau/tableau-mcp.git . && git checkout "${TABLEAU_MCP_REF}")
RUN npm ci --ignore-scripts && npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Prod deps only (no lifecycle scripts), then the compiled output.
COPY --from=build /src/package.json /src/package-lock.json ./
RUN npm ci --omit=dev --production --ignore-scripts
COPY --from=build /src/build ./build
RUN chmod +x build/index.js || true

# ── HTTP transport defaults (overridable at runtime) ─────────────────────────
# TRANSPORT=http switches the server from stdio to the streamable-HTTP listener.
# The server reads PORT (default 3927) and serves MCP at path /tableau-mcp.
# AUTH=pat selects Personal Access Token auth; SERVER/SITE_NAME/PAT_NAME/PAT_VALUE
# are injected at runtime (PAT_VALUE from Secrets Manager) — never baked in.
ENV TRANSPORT=http
ENV PORT=3927
ENV AUTH=pat

USER node
EXPOSE 3927
ENTRYPOINT ["node", "build/index.js"]
