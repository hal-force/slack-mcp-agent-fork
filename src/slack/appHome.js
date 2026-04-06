const { getDefaultTableauMcpUrl, validateTableauMcpUserUrl } = require("../assistant/tableauMcpClient");
const { getInstallUrl } = require("../install-kit/env");
const {
  getTableauMcpUrlOverride,
  setTableauMcpUrlOverride,
  installQueryFromInteractiveBody,
} = require("../preferences/userPreferences");

const ACTION_OPEN_TABLEAU_SETTINGS = "open_tableau_mcp_settings";
const ACTION_NAV_HOME = "prism_app_home_nav_home";
const ACTION_NAV_SETTINGS = "prism_app_home_nav_settings";
const VIEW_TABLEAU_MCP_MODAL = "tableau_mcp_url_modal";

/** Encode current URL for the button `value` (read at click time — avoids a DB round-trip before views.open). */
function encodeTableauUrlForButtonValue(url) {
  const v = url == null ? "" : String(url);
  const payload = JSON.stringify({ v });
  if (payload.length > 2000) {
    return JSON.stringify({ v: `${v.slice(0, 1900)}…` });
  }
  return payload;
}

function decodeTableauUrlFromButtonValue(raw) {
  if (raw == null || raw === "") return "";
  try {
    const o = JSON.parse(String(raw));
    return typeof o.v === "string" ? o.v : "";
  } catch {
    return "";
  }
}

function truncateUrl(s, max = 72) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

/**
 * Modal copy: instructions, current value, and what “empty + save” does.
 * @param {{ current: string, hostDefault: string }} opts
 */
function buildTableauMcpModalIntroMrkdwn(opts) {
  const current = opts.current || "";
  const hostDefault = (opts.hostDefault || "").trim();

  const instructions =
    "Enter the *https* base URL for your Tableau MCP server (Streamable HTTP). " +
    "This setting applies only to *you* in this workspace.";

  let currentLine;
  if (current.trim()) {
    currentLine = `*Current personal URL:* \`${truncateUrl(current, 72)}\``;
  } else if (hostDefault) {
    currentLine =
      `*Current personal URL:* _No override._ You’re using the host default: \`${truncateUrl(hostDefault, 72)}\`.`;
  } else {
    currentLine =
      "*Current personal URL:* _No override and no host default — Tableau MCP isn’t configured until you set a URL here or on the server._";
  }

  let blankLine;
  if (hostDefault) {
    blankLine =
      `*If you clear the field and save:* your personal override is removed and the app uses the host default: \`${truncateUrl(hostDefault, 72)}\`.`;
  } else {
    blankLine =
      "*If you clear the field and save:* your personal override is removed. There is *no* host default (`TABLEAU_MCP_SERVER`), so Tableau MCP won't connect until you enter a URL here or the deployment sets a default.";
  }

  return `${instructions}\n\n${currentLine}\n\n${blankLine}`;
}

function footerBlocks() {
  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Issues with the app? Try re-installing using the button above ⬆️.\nIf that doesn't work, send a message to Naseer.",
        },
      ],
    },
  ];
}

/** Same three nav buttons on every page (matches App Home layout in Slack). */
function navActions(installUrl) {
  const elements = [
    {
      type: "button",
      text: { type: "plain_text", text: "Home", emoji: true },
      action_id: ACTION_NAV_HOME,
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Settings", emoji: true },
      action_id: ACTION_NAV_SETTINGS,
    },
  ];
  if (installUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Re-install", emoji: true },
      url: installUrl,
    });
  }
  return { type: "actions", elements };
}

async function buildWelcomeBlocks(installQuery, installUrl) {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: ":house: Home", emoji: true },
			"level": 1
    },
    navActions(installUrl),
		{
			"type": "divider"
		},
    { "type": "header",
      "text": { "type": "plain_text", "text": "About this assistant", "emoji":true},"level":2
    },
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": "Ask in Assistant mode or @-mention the app for answers with Slack and Tableau context. \nTableau MCP is optional and can be configured in the Settings section above.\n"
			}
		},
		{
			"type": "divider"
		},
    ...footerBlocks(),
  ];
}

async function buildSettingsBlocks(installQuery, installUrl) {
  const override = await getTableauMcpUrlOverride(installQuery);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: ":gear: Settings", emoji: true },
			"level": 1
		},
    navActions(installUrl),
    { type: "divider" },
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": "MCP Settings",
				"emoji": true
			},
			"level": 2
		},
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Tableau MCP",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Set URL", emoji: true },
        action_id: ACTION_OPEN_TABLEAU_SETTINGS,
        value: encodeTableauUrlForButtonValue(override || ""),
      },
    },
    { type: "divider" },
    ...footerBlocks(),
  ];
}

/**
 * @param {{ installQuery: { teamId?: string|null, enterpriseId?: string|null, isEnterpriseInstall?: boolean, userId?: string|null }, page?: 'home' | 'settings' }} opts
 */
async function buildAppHomeBlocks(opts) {
  const page = opts.page === "settings" ? "settings" : "home";
  const installUrl = getInstallUrl();
  if (page === "settings") {
    return buildSettingsBlocks(opts.installQuery, installUrl);
  }
  return buildWelcomeBlocks(opts.installQuery, installUrl);
}

/**
 * @param {import("@slack/web-api").WebClient} client
 * @param {string} userId
 * @param {{ teamId?: string|null, enterpriseId?: string|null, isEnterpriseInstall?: boolean }} teamCtx
 * @param {'home' | 'settings'} [page]
 */
async function publishAppHome(client, userId, teamCtx, page = "home") {
  const installQuery = {
    userId,
    teamId: teamCtx.teamId ?? null,
    enterpriseId: teamCtx.enterpriseId ?? null,
    isEnterpriseInstall: !!teamCtx.isEnterpriseInstall,
  };
  const blocks = await buildAppHomeBlocks({ installQuery, page });
  await client.views.publish({
    user_id: userId,
    view: { type: "home", blocks },
  });
}

function teamCtxFromInteractiveBody(body) {
  const iq = installQueryFromInteractiveBody(body);
  return {
    teamId: iq.teamId ?? null,
    enterpriseId: iq.enterpriseId ?? null,
    isEnterpriseInstall: !!iq.isEnterpriseInstall,
  };
}

/**
 * @param {import("@slack/bolt").App} app
 */
function registerAppHome(app) {
  app.event("app_home_opened", async ({ event, context, client, logger }) => {
    if (event.tab !== "home") return;
    try {
      await publishAppHome(client, event.user, {
        teamId: context.teamId,
        enterpriseId: context.enterpriseId ?? null,
        isEnterpriseInstall: !!context.isEnterpriseInstall,
      }, "home");
    } catch (err) {
      logger.error("app_home_opened publish error", err);
    }
  });

  app.action(ACTION_NAV_HOME, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await publishAppHome(client, body.user.id, teamCtxFromInteractiveBody(body), "home");
    } catch (err) {
      logger.error("prism_nav_home error", err);
    }
  });

  app.action(ACTION_NAV_SETTINGS, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      await publishAppHome(client, body.user.id, teamCtxFromInteractiveBody(body), "settings");
    } catch (err) {
      logger.error("prism_nav_settings error", err);
    }
  });

  app.action(ACTION_OPEN_TABLEAU_SETTINGS, async ({ ack, body, client, logger }) => {
    await ack();
    try {
      const iq = installQueryFromInteractiveBody(body);
      const actionPayload = body.actions?.[0];
      const rawBtn = actionPayload?.value;
      const hasButtonPayload = typeof rawBtn === "string" && rawBtn.length > 0;
      const current = hasButtonPayload
        ? decodeTableauUrlFromButtonValue(rawBtn)
        : (await getTableauMcpUrlOverride(iq)) || "";

      const hostDefault = getDefaultTableauMcpUrl();
      const modalIntro = buildTableauMcpModalIntroMrkdwn({ current, hostDefault });

      const inputEl = {
        type: "plain_text_input",
        action_id: "tableau_url_value",
        placeholder: { type: "plain_text", text: "https://example.com/tableau-mcp" },
        max_length: 2000,
      };
      if (current) inputEl.initial_value = current;

      const result = await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          callback_id: VIEW_TABLEAU_MCP_MODAL,
          private_metadata: JSON.stringify({
            teamId: iq.teamId || "",
            enterpriseId: iq.enterpriseId || "",
            isEnterpriseInstall: !!iq.isEnterpriseInstall,
            userId: iq.userId || "",
          }),
          title: { type: "plain_text", text: "Tableau MCP URL" },
          submit: { type: "plain_text", text: "Save" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: modalIntro,
              },
            },
            {
              type: "input",
              block_id: "tableau_url_block",
              optional: true,
              label: { type: "plain_text", text: "Base URL" },
              element: inputEl,
            },
          ],
        },
      });

      if (!result.ok) {
        logger.error(
          "views.open failed for Tableau MCP modal",
          result.error || result,
        );
      }
    } catch (err) {
      const apiErr = err?.data?.error || err?.message || err;
      logger.error("open Tableau MCP settings modal error", apiErr, err);
    }
  });

  app.view(VIEW_TABLEAU_MCP_MODAL, async ({ ack, view, body, client, logger }) => {
    const rawInput =
      view.state.values?.tableau_url_block?.tableau_url_value?.value?.trim() || "";

    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || "{}");
    } catch (_) {
      await ack({
        response_action: "errors",
        errors: { tableau_url_block: "Invalid form state; close and try again." },
      });
      return;
    }

    const validated = validateTableauMcpUserUrl(rawInput);
    if (!validated.ok) {
      await ack({
        response_action: "errors",
        errors: { tableau_url_block: validated.error },
      });
      return;
    }

    await ack();

    const installQuery = {
      userId: meta.userId || body.user?.id,
      teamId: meta.teamId || null,
      enterpriseId: meta.enterpriseId || null,
      isEnterpriseInstall: !!meta.isEnterpriseInstall,
    };

    try {
      await setTableauMcpUrlOverride(installQuery, validated.url);
      await publishAppHome(client, body.user.id, {
        teamId: installQuery.teamId,
        enterpriseId: installQuery.enterpriseId,
        isEnterpriseInstall: installQuery.isEnterpriseInstall,
      }, "settings");
    } catch (err) {
      logger.error("save Tableau MCP URL preference error", err);
    }
  });
}

module.exports = { registerAppHome, publishAppHome, buildAppHomeBlocks };
