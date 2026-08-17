# TLS CA bundles

## `rds-global-bundle.pem`

The **Amazon RDS global CA bundle** (public, non-secret — safe to commit).
Downloaded from:

```
https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

### Why it's here

The database is Amazon Aurora/RDS. Its server certificate chains to an Amazon
RDS certificate authority that is **not** in Node's default trust store, so a
strict TLS connection (`rejectUnauthorized: true`, the default in
`src/install-kit/prisma.js`) fails with
`unable to get local issuer certificate` and every DB query — including the
Slack `authorize` lookup — 401s.

### How to use it (production tier)

Point the DB connection at this bundle so certificate verification stays **on**
and succeeds:

```
heroku config:set PGSSLROOTCERT=certs/rds-global-bundle.pem -a <prod-app>
heroku config:unset DATABASE_SSL_NO_VERIFY -a <prod-app>   # remove the demo escape hatch
```

`src/install-kit/prisma.js` reads `PGSSLROOTCERT` (or `DATABASE_SSL_CA_FILE`)
and passes the PEM as the `ca` for the `pg` Pool.

### Demo tier

The demo app (`damp-wave-30118`) currently runs with
`DATABASE_SSL_NO_VERIFY=1` instead — TLS stays encrypted but issuer
verification is skipped. That's the fast, reversible posture for a demo; use the
CA bundle above for any real production deployment.

### Refreshing

Amazon rotates these CAs periodically. Re-download the bundle from the URL above
if verification starts failing after a cert rotation.
