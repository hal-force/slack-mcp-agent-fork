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
const sslOption = isLocal ? false : { rejectUnauthorized: false };

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