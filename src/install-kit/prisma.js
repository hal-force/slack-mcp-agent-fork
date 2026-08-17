// src/install-kit/prisma.js
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

// Use SSL only for non-local DBs (e.g. cloud). Local Postgres usually has SSL disabled.
const connectionString = process.env.DATABASE_URL;
const isLocal =
  connectionString.includes("localhost") ||
  connectionString.includes("127.0.0.1") ||
  connectionString.includes("sslmode=disable");

// Verify the DB server certificate by default so the connection carrying our
// tokens can't be transparently MITM'd. Heroku Postgres presents a cert signed
// by a CA the platform trusts; if a deployment needs a custom CA, provide it via
// PGSSLROOTCERT (PEM). Only disable verification if explicitly opted out with
// DATABASE_SSL_NO_VERIFY=1 (e.g. a self-signed dev/staging DB) — never silently.
const fs = require("fs");
function buildSslOption() {
  if (isLocal) return false;
  if (process.env.DATABASE_SSL_NO_VERIFY === "1") {
    console.warn(
      "[prisma] DATABASE_SSL_NO_VERIFY=1 — TLS certificate verification is DISABLED for the database connection. Do not use in production.",
    );
    return { rejectUnauthorized: false };
  }
  const caPath = process.env.PGSSLROOTCERT || process.env.DATABASE_SSL_CA_FILE;
  const ca = caPath ? fs.readFileSync(caPath, "utf8") : undefined;
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}
const sslOption = buildSslOption();

const pool = new Pool({
  connectionString,
  ssl: sslOption,
});

const adapter = new PrismaPg(pool);

// singleton
const prisma = new PrismaClient({ adapter });

// compatibility for callers expecting getPrisma()
function getPrisma() {
  return prisma;
}

module.exports = { prisma, getPrisma };