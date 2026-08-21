# Tableau MCP server image

Packages the official [`tableau/tableau-mcp`](https://github.com/tableau/tableau-mcp)
server as a deployable container, defaulted to the **streamable-HTTP** transport so
it can run on AWS App Runner and be reached by the Slack agent at
`https://<host>/tableau-mcp`.

We build from a **pinned upstream ref** (`TABLEAU_MCP_REF`, default `v4.5.1`) rather
than vendoring the source — upgrades are a one-line bump, no private fork to drift.

## Build

For a **local** build (run/test on your own machine), the plain command is fine:

```bash
docker build --build-arg TABLEAU_MCP_REF=v4.5.1 -t tableau-mcp:local deploy/tableau-mcp
```

When building the image you'll **push to ECR for App Runner**, add
`--platform linux/amd64 --provenance=false --sbom=false` — App Runner only runs
amd64 and cannot pull the OCI image index BuildKit produces without those flags.
See [`../aws/SKILL.md`](../aws/SKILL.md) Phase 2 for the full push sequence.

## Runtime environment

Baked-in transport defaults (override at runtime if needed):

| Var | Default | Purpose |
|-----|---------|---------|
| `TRANSPORT` | `http` | Switch from stdio to the streamable-HTTP listener. |
| `PORT` | `3927` | HTTP listen port. App Runner injects its own `PORT`; the listener honors it. |
| `AUTH` | `pat` | Personal Access Token auth. |

Supplied per-deployment (PAT secret comes from AWS Secrets Manager — never baked in):

| Var | Example | Purpose |
|-----|---------|---------|
| `SERVER` | `https://prod-useast-a.online.tableau.com` | Tableau Cloud/Server base URL. |
| `SITE_NAME` | `usfederaldemos` | Tableau site content-url. |
| `PAT_NAME` | `slack-agent` | PAT name. |
| `PAT_VALUE` | *(secret)* | PAT secret. **Secrets Manager only.** |

Optional: `CORS_ORIGIN_CONFIG` (browser CORS allowlist), `DEFAULT_LOG_LEVEL`,
`INCLUDE_TOOLS` / `EXCLUDE_TOOLS`, `MAX_RESULT_LIMIT`.

## Two operational notes verified against upstream `v4.5.1`

- **CORS does not block the agent.** The server applies the `cors` middleware with
  `origin: config.corsOriginConfig`, but that only gates *browser* cross-origin
  calls (requests carrying an `Origin` header). The Slack agent calls server-to-server
  with **no `Origin` header**, so it is unaffected by the CORS allowlist — the same
  reason the current Heroku-hosted MCP works today. `CORS_ORIGIN_CONFIG` only needs
  setting if a browser-based MCP client will call it.
- **No dedicated `/health` route exists.** The MCP path (`POST/GET/DELETE /tableau-mcp`)
  is the only surface. App Runner's health check for this service must therefore be
  **TCP** (port open), not an HTTP path check. (The Terraform sets this.)

## PAT / concurrent-session caveat

A single Tableau PAT cannot hold two concurrent HTTP sessions — simultaneous signins
terminate each other. This server is the **one** steady-state consumer of its PAT, so
give it a dedicated PAT and do not reuse that PAT for ad-hoc REST calls while the
service is live.
