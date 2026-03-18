const { ExpressReceiver, LogLevel } = require("@slack/bolt");
const { requireEnv, getBotScopes, getUserScopes, getSlackLogLevel } = require("./env");

const LOG_LEVEL_MAP = { debug: LogLevel.DEBUG, info: LogLevel.INFO, warn: LogLevel.WARN, error: LogLevel.ERROR };
const { createInstallationStore } = require("./installationStore");

function createReceiver() {
  const botScopes = getBotScopes();
  const userScopes = getUserScopes();
  if (botScopes.length === 0) {
    throw new Error("At least SLACK_BOT_SCOPES or SLACK_SCOPES must be set.");
  }

  const receiver = new ExpressReceiver({
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
    clientId: requireEnv("SLACK_CLIENT_ID"),
    clientSecret: requireEnv("SLACK_CLIENT_SECRET"),
    stateSecret: requireEnv("SLACK_STATE_SECRET"),

    scopes: botScopes,

    installationStore: createInstallationStore(),

    installerOptions: {
      installPath: "/slack/install",
      redirectUriPath: "/slack/oauthcallback",
      directInstall: true,
      stateVerification: false,
      userScopes: userScopes.length > 0 ? userScopes : undefined,
    },


    logLevel: LOG_LEVEL_MAP[getSlackLogLevel()] ?? LogLevel.INFO,
  });

  return receiver;
}

module.exports = { createReceiver };
