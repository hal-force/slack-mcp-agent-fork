require("dotenv").config();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function envOptional(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}

function parseScopes(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Scopes Slack treats as invalid when requested (e.g. generic "search:read" is invalid; use search:read.public etc.)
const INVALID_SCOPES = new Set(["search:read"]);

function dedupeScopes(arr) {
  const seen = new Set();
  return arr.filter((s) => {
    if (seen.has(s) || INVALID_SCOPES.has(s)) return false;
    seen.add(s);
    return true;
  });
}

/**
 * Bot scopes (xoxb) for the install URL. Passed as `scopes` to Bolt.
 */
function getBotScopes() {
  const hasBot = envOptional("SLACK_BOT_SCOPES", "").trim();
  const hasUser = envOptional("SLACK_USER_SCOPES", "").trim();
  if (hasBot || hasUser) {
    return dedupeScopes(parseScopes(envOptional("SLACK_BOT_SCOPES", "")));
  }
  return dedupeScopes(parseScopes(envOptional("SLACK_SCOPES", "")));
}

/**
 * User scopes (xoxp) for the install URL. Passed as `installerOptions.userScopes` to Bolt.
 * Slack requires bot and user scopes to be requested separately.
 */
function getUserScopes() {
  const hasBot = envOptional("SLACK_BOT_SCOPES", "").trim();
  const hasUser = envOptional("SLACK_USER_SCOPES", "").trim();
  if (hasBot || hasUser) {
    return dedupeScopes(parseScopes(envOptional("SLACK_USER_SCOPES", "")));
  }
  return [];
}

/**
 * Combined scopes (for backward compatibility). Prefer getBotScopes/getUserScopes.
 */
function getInstallScopes() {
  const bot = getBotScopes();
  const user = getUserScopes();
  if (bot.length === 0 && user.length === 0) {
    throw new Error(
      "Set SLACK_SCOPES (legacy) or at least one of SLACK_BOT_SCOPES / SLACK_USER_SCOPES"
    );
  }
  return [...bot, ...user];
}

module.exports = { requireEnv, envOptional, parseScopes, getInstallScopes, getBotScopes, getUserScopes };
