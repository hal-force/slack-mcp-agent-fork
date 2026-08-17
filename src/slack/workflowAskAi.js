/**
 * Slack Workflow Builder → custom function identifiers
 *
 * Slack’s app UI often generates opaque ids for the function and each parameter. They must match
 * the live app manifest exactly or Bolt will not route `function_executed` here / inputs will be empty /
 * `complete()` output keys will be rejected.
 *
 * Manifest mapping:
 * - Callback id: top-level key under `functions` and `function_executed.function.callback_id`
 * - Prompt input: `input_parameters.<key>.name` and the key used in `function_executed.inputs`
 * - Optional “post here” channel: when set, we also `chat.postMessage` with Block Kit **section** + **mrkdwn** (not rich_text) so formatting renders
 * - AI response output: `output_parameters.<key>.name` and the key required in `complete({ outputs })`
 *
 * Override per deployment (another Slack app / regenerated ids) with env vars — no code edit needed.
 */
const WORKFLOW_FUNCTION_CALLBACK_ID =
  process.env.SLACK_WORKFLOW_ASK_AI_CALLBACK_ID || "9dec78"; // Ask AI step (manifest `functions` key)

const WORKFLOW_PROMPT_INPUT_NAME =
  process.env.SLACK_WORKFLOW_ASK_AI_PROMPT_INPUT || "afd46a"; // expanded_rich_text prompt field `name`

const WORKFLOW_AI_RESPONSE_OUTPUT_NAME =
  process.env.SLACK_WORKFLOW_ASK_AI_RESPONSE_OUTPUT || "8f09f2"; // string output `name` for Workflow Builder

/** Optional `slack#/types/channel` input `name` — when present, post AI text as section+mrkdwn blocks. */
const WORKFLOW_POST_CHANNEL_INPUT_NAME =
  process.env.SLACK_WORKFLOW_ASK_AI_POST_CHANNEL_INPUT || "b504c1";

const { parseChannelRefs } = require("../assistant/slackContext");
const { classifyIntent } = require("../router/intentRouter");
const { installQueryFromBoltContext } = require("../install-kit/installQuery");
const { getUserLocaleContext } = require("../assistant/userLocale");
const { getInstallation } = require("../install-kit/installationStore");
const { getInstallUrl } = require("../install-kit/env");
const { getUserPreferences } = require("../preferences/userPreferences");
const { resolveTableauMcpUrl } = require("../assistant/tableauMcpClient");
const { resolveActiveSkills, executeActiveSkills } = require("../skills/registry");
const { resolveSlackMrkdwnEntities } = require("./resolveSlackMrkdwnEntities");
const { mrkdwnStringToBlocks } = require("./mrkdwnToBlocks");
const { postThreadFileUploads } = require("./postThreadFileUploads");
const { embedImagesInCanvases } = require("../canvas/canvasImages");
const {
  authorizeMessageWithOptionalInstallUrl,
  modelContextChannelAccessReinstallNote,
  postFileUploadReinstallHintIfNeeded,
} = require("./reinstallPrompt");

function workflowAuthorizeMessage() {
  return authorizeMessageWithOptionalInstallUrl(getInstallUrl());
}

/** @deprecated Use WORKFLOW_FUNCTION_CALLBACK_ID; kept for callers that imported the old export. */
const ASK_AI_CALLBACK_ID = WORKFLOW_FUNCTION_CALLBACK_ID;

/**
 * Read prompt from `inputs[primaryKey]`, or if missing and there is exactly one input, use that key
 * (Slack sometimes regenerates parameter ids; env may be stale).
 *
 * @param {Record<string, unknown>|undefined|null} inputs
 * @param {string} primaryKey
 * @returns {{ value: unknown, resolvedKey: string|null, inputKeys: string[] }}
 */
function resolveWorkflowPromptInput(inputs, primaryKey) {
  const inputKeys = inputs && typeof inputs === "object" ? Object.keys(inputs) : [];
  if (!inputs || typeof inputs !== "object") {
    return { value: undefined, resolvedKey: null, inputKeys };
  }
  if (Object.prototype.hasOwnProperty.call(inputs, primaryKey) && inputs[primaryKey] != null) {
    return { value: inputs[primaryKey], resolvedKey: primaryKey, inputKeys };
  }
  if (inputKeys.length === 1 && inputs[inputKeys[0]] != null) {
    return { value: inputs[inputKeys[0]], resolvedKey: inputKeys[0], inputKeys };
  }
  return { value: undefined, resolvedKey: null, inputKeys };
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function coerceStringInput(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "value" in v && typeof v.value === "string") {
    return v.value;
  }
  if (typeof v === "object" && v !== null) {
    return "";
  }
  return String(v);
}

const MAX_JSON_PROMPT_CHARS = 100000;

/**
 * When Workflow Builder injects a whole step object (not rich_text), avoid String(obj) === "[object Object]".
 * @param {object} o
 * @returns {string}
 */
function objectPromptFallback(o) {
  try {
    const j = JSON.stringify(o);
    if (!j || j === "{}" || j === "null") return "";
    return j.length > MAX_JSON_PROMPT_CHARS ? j.slice(0, MAX_JSON_PROMPT_CHARS) + "\n…(truncated)" : j;
  } catch {
    return "";
  }
}

/** True if Slack/workflow interpolation left a useless Object.prototype.toString in the prompt. */
function isPlaceholderObjectString(s) {
  const v = s || "";
  return v.trim() === "[object Object]" || v.includes("[object Object]");
}

/**
 * Inline rich_text element → Slack mrkdwn-ish fragment.
 * @param {unknown} el
 * @returns {string}
 */
function inlineToString(el) {
  if (el == null || typeof el !== "object") return "";
  const t = el.type;
  if (t === "text" && typeof el.text === "string") {
    let s = el.text;
    const st = el.style || {};
    if (st.code) return `\`${s}\``;
    if (st.strike) s = `~${s}~`;
    if (st.bold) s = `*${s}*`;
    if (st.italic) s = `_${s}_`;
    return s;
  }
  if (t === "user" && el.user_id) return `<@${el.user_id}>`;
  if (t === "usergroup" && el.usergroup_id) return `<!subteam^${el.usergroup_id}>`;
  if (t === "channel") {
    const cid = el.channel_id || (el.channel && el.channel.id) || el.channel;
    if (cid && typeof cid === "string") return `<#${cid}>`;
  }
  if (t === "link" && el.url) {
    const label = typeof el.text === "string" && el.text ? el.text : el.url;
    return `<${el.url}|${label}>`;
  }
  if (t === "emoji" && el.name) return `:${el.name}:`;
  if (t === "broadcast" && el.range === "here") return "<!here>";
  if (t === "broadcast" && el.range === "channel") return "<!channel>";
  return "";
}

/**
 * One block-level rich_text element (section, list, quote, preformatted, …).
 * @param {unknown} block
 * @returns {string}
 */
function blockToString(block) {
  if (block == null || typeof block !== "object") return "";
  const t = block.type;
  const inner = block.elements;

  if (t === "rich_text_section" && Array.isArray(inner)) {
    return inner.map(inlineToString).join("");
  }

  if (t === "rich_text_list" && Array.isArray(inner)) {
    const style = block.style;
    const indent = typeof block.indent === "number" ? block.indent : 0;
    const pad = "  ".repeat(indent);
    const lines = [];
    let n = 0;
    for (const item of inner) {
      n += 1;
      const lineBody = blockToString(item);
      const bullet = style === "ordered" ? `${n}. ` : "• ";
      lines.push(`${pad}${bullet}${lineBody}`);
    }
    return lines.join("\n");
  }

  if (t === "rich_text_quote" && Array.isArray(inner)) {
    const body = inner.map((x) => blockToString(x) || inlineToString(x)).join("");
    return body
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
  }

  if (t === "rich_text_preformatted" && Array.isArray(inner)) {
    const body = inner.map((x) => blockToString(x) || inlineToString(x)).join("");
    return "```\n" + body + "\n```";
  }

  if (t === "rich_text_header" && Array.isArray(inner)) {
    const body = inner.map(inlineToString).join("");
    return body ? `*${body.toUpperCase()}*` : "";
  }

  if (Array.isArray(inner)) {
    return inner.map((x) => blockToString(x) || inlineToString(x)).join("");
  }

  return inlineToString(block);
}

/**
 * Workflow Builder passes expanded/rich text objects under the manifest input `name` key.
 * @param {unknown} input
 * @returns {string}
 */
function promptInputToUserMessage(input) {
  if (input == null) return "";

  // Workflow Builder sometimes sends a single-element array: [{ type: "expanded_rich_text", elements: [...] }]
  if (Array.isArray(input)) {
    const parts = input.map((item) => promptInputToUserMessage(item));
    const out = parts
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (out) return out;
    return objectPromptFallback(input) || "";
  }

  if (typeof input === "string") {
    return input.trim();
  }

  if (typeof input === "object" && input !== null) {
    const o = input;
    if ("value" in o && typeof o.value === "object" && o.value !== null) {
      return promptInputToUserMessage(o.value);
    }

    const rtType = o.type;
    if (
      (rtType === "rich_text" || rtType === "expanded_rich_text") &&
      Array.isArray(o.elements)
    ) {
      const parts = o.elements.map((b) => blockToString(b)).filter(Boolean);
      const out = parts.join("\n\n").trim();
      if (out) return out;
      // Slack sent blocks we did not map to text; keep full payload so the model still sees content.
      return objectPromptFallback(o) || "";
    }

    if (Array.isArray(o.elements)) {
      const parts = o.elements.map((b) => blockToString(b)).filter(Boolean);
      const out = parts.join("\n\n").trim();
      if (out) return out;
      return objectPromptFallback(o) || "";
    }
  }

  if (typeof input === "object" && input !== null) {
    const json = objectPromptFallback(input);
    if (json) return json;
    return "";
  }

  return coerceStringInput(input).trim();
}

/**
 * Workflow may pass channel as a string id or a small object from Slack.
 * @param {unknown} v
 * @returns {string|null}
 */
function coerceWorkflowChannelId(v) {
  if (v == null) return null;
  if (typeof v === "string" && /^C[A-Z0-9]+$/i.test(v.trim())) return v.trim().toUpperCase();
  if (typeof v === "object" && v !== null) {
    const o = v;
    const id = o.id ?? o.channel_id ?? o.channel?.id;
    if (id && typeof id === "string" && /^C[A-Z0-9]+$/i.test(id)) return id.toUpperCase();
  }
  return null;
}

function workflowInstallQuery(body, event) {
  return {
    teamId: body?.team_id || body?.authorizations?.[0]?.team_id || event?.team || event?.team_id,
    enterpriseId:
      body?.enterprise_id || body?.authorizations?.[0]?.enterprise_id || event?.enterprise_id,
    isEnterpriseInstall:
      !!body?.is_enterprise_install || !!body?.authorizations?.[0]?.is_enterprise_install,
    userId:
      body?.user_id ||
      event?.user ||
      event?.user_id ||
      body?.authorizations?.[0]?.user_id,
  };
}

/**
 * @param {*} app - Slack Bolt App instance
 * @param {{ getAiResponse: (args: object) => Promise<{ text: string, uploads?: object[] }> }} deps
 */
function registerAskAiWorkflowStep(app, { getAiResponse }) {
  app.function(
    WORKFLOW_FUNCTION_CALLBACK_ID,
    { autoAcknowledge: false },
    async ({ inputs, complete, fail, logger, client, body }) => {
      try {
        const event = body?.event || {};
        const { value: rawPrompt, resolvedKey, inputKeys } = resolveWorkflowPromptInput(
          inputs,
          WORKFLOW_PROMPT_INPUT_NAME,
        );
        const userMessage = promptInputToUserMessage(rawPrompt);
        const { ids: channelIdsFromPrompt } = parseChannelRefs(userMessage);

        if (isPlaceholderObjectString(userMessage)) {
          await fail({
            error:
              "Prompt resolved to an unusable value. In Workflow Builder, insert a variable that expands to text (e.g. a specific form field), not an entire form or object.",
          });
          return;
        }
        if (!userMessage) {
          await fail({
            error:
              "Prompt is empty. Add text in the prompt field or insert variables from a previous workflow step.",
          });
          return;
        }

        const installQuery = installQueryFromBoltContext(body, {}, event);
        const [installation, prefs, localeContext] = await Promise.all([
          getInstallation(installQuery),
          getUserPreferences(installQuery),
          getUserLocaleContext(client, installQuery.userId),
        ]);
        const useInternetSearch = prefs.internetSearch;
        // Effective URL = per-user override, else the host default (TABLEAU_MCP_SERVER).
        const tableauMcpBaseUrl = resolveTableauMcpUrl(prefs.tableauMcpUrl);

        const teamId =
          body?.team_id ||
          body?.authorizations?.[0]?.team_id ||
          event?.team ||
          event?.team_id ||
          null;

        const postChannelId =
          coerceWorkflowChannelId(inputs?.[WORKFLOW_POST_CHANNEL_INPUT_NAME]) ||
          (() => {
            const c = (process.env.SLACK_WORKFLOW_ASK_AI_POST_CHANNEL_ID || "").trim();
            return /^C[A-Z0-9]+$/i.test(c) ? c.toUpperCase() : null;
          })();

        const primaryChannelId = postChannelId || channelIdsFromPrompt[0] || null;

        const { useFullModel, intents } = classifyIntent(userMessage, {
          tableauEnabled: !!tableauMcpBaseUrl,
          hasUserToken: !!installation?.user?.token,
          internetSearch: useInternetSearch,
        });

        const userToken = installation?.user?.token;
        const activeSkills = resolveActiveSkills({
          userToken,
          defaultChannelId: primaryChannelId,
          teamId,
          tableauMcpBaseUrl,
          internetSearchEnabled: useInternetSearch,
        });

        const [skillResult] = await Promise.all([
          executeActiveSkills(activeSkills, intents, {
            userMessage,
            client,
            sessionOpts: {
              userToken,
              channelId: primaryChannelId || undefined,
              threadTs: null,
              userMessage,
              skipChannelAndThread: !primaryChannelId,
              // includeSearch omitted → workspace search runs only on a
              // slack_search intent (E4).
              contextChannelId: postChannelId || undefined,
              teamId,
              tableauMcpBaseUrl,
              defaultChannelId: primaryChannelId,
            },
          }),
        ]);

        const skillContext = [localeContext, ...skillResult.contextParts].filter(Boolean).join("\n");

        const logPayload = {
          tag: "workflow_ask_ai",
          callbackId: WORKFLOW_FUNCTION_CALLBACK_ID,
          expectedPromptKey: WORKFLOW_PROMPT_INPUT_NAME,
          resolvedKey,
          inputKeys,
          keyMismatch: resolvedKey != null && resolvedKey !== WORKFLOW_PROMPT_INPUT_NAME,
          rawType: rawPrompt === undefined ? "undefined" : typeof rawPrompt,
          richType:
            Array.isArray(rawPrompt) && rawPrompt[0] && typeof rawPrompt[0] === "object"
              ? rawPrompt[0].type
              : rawPrompt && typeof rawPrompt === "object" && rawPrompt !== null && "type" in rawPrompt
                ? rawPrompt.type
                : null,
          promptChars: userMessage.length,
          promptHead: userMessage.slice(0, 100).replace(/\s+/g, " ").trim(),
          channelIdsInPrompt: channelIdsFromPrompt,
          primaryChannelId,
          skillContextChars: skillContext.length,
          googleSearchActive: skillResult.googleSearchActive,
          hasUserToken: !!userToken,
          tableauMcpConfigured: !!tableauMcpBaseUrl,
        };
        logger.info(`[workflow_ask_ai] ${JSON.stringify(logPayload)}`);

        const aiResult = await getAiResponse({
          userMessage,
          skillContext: skillContext || undefined,
          uploads: skillResult.uploads,
          sideEffects: skillResult.sideEffects,
          googleSearchActive: skillResult.googleSearchActive,
          systemPromptSections: skillResult.systemPromptSections,
          userToken,
          defaultCanvasChannelId: postChannelId || primaryChannelId || null,
          teamId,
          useFullModel,
          tableauMcpBaseUrl,
        });

        let aiText = aiResult.text;
        const aiUploads = aiResult.uploads || [];

        if (!installation) {
          aiText = `${aiText}\n\n---\n${workflowAuthorizeMessage()}`;
        }

        if (client && aiText && typeof aiText === "string") {
          try {
            aiText = await resolveSlackMrkdwnEntities(client, aiText, {
              plainUserNames: process.env.SLACK_WORKFLOW_ASK_AI_PLAIN_USER_NAMES !== "0",
              logger,
            });
          } catch (resolveErr) {
            logger.warn(
              `[workflow_ask_ai] resolveSlackMrkdwnEntities skipped: ${resolveErr?.message || resolveErr}`,
            );
          }
        }

        if (postChannelId && client && aiText && typeof aiText === "string") {
          try {
            const { text: notifyText, blocks } = mrkdwnStringToBlocks(aiText);
            await client.chat.postMessage({
              channel: postChannelId,
              text: notifyText,
              blocks,
            });
            logger.info(
              `[workflow_ask_ai] posted Block Kit mrkdwn sections len=${blocks?.length ?? 0} channel=${postChannelId}`,
            );
          } catch (postErr) {
            logger.warn(
              `[workflow_ask_ai] chat.postMessage (mrkdwn blocks) failed: ${postErr?.message || postErr}`,
            );
          }
        }

        // Reply is out — now run the deferred canvas side effects (title + write).
        const canvasUpdates = await aiResult.runSideEffects();

        if (postChannelId && client && aiUploads.length) {
          try {
            const imageRefs = await postThreadFileUploads(client, {
              channelId: postChannelId,
              threadTs: null,
              uploads: aiUploads,
            });
            if (canvasUpdates?.length && imageRefs.length && userToken) {
              const embedded = await embedImagesInCanvases({
                userToken,
                canvasUpdates,
                imageRefs,
                teamId,
                defaultChannelId: postChannelId,
              });
              logger.info(
                `[workflow_ask_ai] embedded ${imageRefs.length} image(s) into ${embedded} canvas(es)`,
              );
            }
          } catch (uploadErr) {
            logger.warn(
              `[workflow_ask_ai] files.uploadV2 failed: ${uploadErr?.message || uploadErr}`,
            );
            await postFileUploadReinstallHintIfNeeded({
              client,
              channelId: postChannelId,
              threadTs: null,
              err: uploadErr,
              logger,
            });
          }
        }

        await complete({
          outputs: { [WORKFLOW_AI_RESPONSE_OUTPUT_NAME]: aiText },
        });
      } catch (err) {
        logger.error(
          `workflow step error [callback_id=${WORKFLOW_FUNCTION_CALLBACK_ID}]`,
          err,
        );
        await fail({
          error:
            (err && err.message) ||
            "slack-mcp-agent hit an unexpected error while running the Ask AI step.",
        });
      }
    },
  );
}

module.exports = {
  registerAskAiWorkflowStep,
  /** Manifest `functions` key / `function_executed.function.callback_id` */
  WORKFLOW_FUNCTION_CALLBACK_ID,
  /** Input parameter `name` for the prompt (expanded_rich_text) */
  WORKFLOW_PROMPT_INPUT_NAME,
  /** Output parameter `name` for `complete({ outputs })` */
  WORKFLOW_AI_RESPONSE_OUTPUT_NAME,
  /** Optional channel input `name` for posting section+mrkdwn blocks */
  WORKFLOW_POST_CHANNEL_INPUT_NAME,
  ASK_AI_CALLBACK_ID,
  promptInputToUserMessage,
  resolveWorkflowPromptInput,
};
