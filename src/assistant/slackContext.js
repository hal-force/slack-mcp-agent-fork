const { WebClient } = require("@slack/web-api");
const { buildContextViaMcp } = require("./slackMcpClient");

/** Slack channel IDs start with C (e.g. C0AL8UCPULW). */
function isChannelId(s) {
  return /^C[A-Z0-9]+$/i.test(String(s || ""));
}

/**
 * Parse channel refs from text. Returns { ids: string[], names: string[] }.
 * - Slack links: <#C0AL8UCPULW|facility-reservations> or <#C0AL8UCPULW> → channel ID
 * - Plain: #facility-reservations → channel name (not ID)
 */
function parseChannelRefs(text) {
  if (!text || typeof text !== "string") return { ids: [], names: [] };
  const ids = new Set();
  const names = new Set();
  // Slack link format: <#CHANNEL_ID|channel-name> or <#CHANNEL_ID>
  const linkRe = /<#(C[A-Z0-9]+)(?:\|[^>]*)?>/gi;
  let m;
  while ((m = linkRe.exec(text)) !== null) ids.add(m[1].toUpperCase());
  // Plain #channel-name (exclude channel IDs - they look like #C0AL8UCPULW)
  const plainRe = /#([a-z0-9][a-z0-9._-]*)/gi;
  while ((m = plainRe.exec(text)) !== null) {
    const s = m[1];
    if (!isChannelId(s)) names.add(s.toLowerCase());
  }
  return { ids: [...ids], names: [...names] };
}

const DEBUG = process.env.SLACK_CONTEXT_DEBUG === "1";

/** Resolve a channel name to channel ID via conversations.list (uses provided client: user or bot). */
async function resolveChannelByName(client, name, teamId) {
  const tryList = async (tid) => {
    try {
      let cursor;
      do {
        const res = await client.conversations.list({
          types: "public_channel,private_channel",
          limit: 200,
          exclude_archived: true,
          ...(tid && { team_id: tid }),
          ...(cursor && { cursor }),
        });
        const ch = (res.channels || []).find(
          (c) => (c.name || "").toLowerCase() === name.toLowerCase()
        );
        if (ch?.id) return ch.id;
        cursor = res.response_metadata?.next_cursor;
      } while (cursor);
    } catch (err) {
      if (DEBUG) console.error("[slackContext] resolveChannelByName error:", err.message);
    }
    return null;
  };
  let cid = await tryList(teamId);
  if (!cid && teamId) cid = await tryList(null); // Enterprise: try without team_id (other workspaces)
  return cid;
}

/**
 * Build Slack context for the AI. When userToken (xoxp) is provided, uses it for MCP and for
 * all Web API reads (channel list/history, search) so user scopes apply. Otherwise uses the
 * bot client (xoxb / bot scopes).
 *
 * @param {import("@slack/web-api").WebClient} client - Slack Web API client (bot token, used when no user token)
 * @param {Object} opts
 * @param {string} [opts.userToken] - Slack user token (xoxp-...); when set, MCP and Web API reads use user scopes
 * @param {string} [opts.channelId] - Current channel ID
 * @param {string} [opts.threadTs] - Thread ts (for thread context)
 * @param {string} [opts.userMessage] - User's message (used for optional search)
 * @param {number} [opts.maxChannelMessages] - Max recent channel messages (default 15)
 * @param {boolean} [opts.includeSearch] - Run search with user message (default true when message has words)
 * @param {boolean} [opts.skipChannelAndThread] - Skip channel/thread fetch (e.g. when caller already has full thread history)
 * @param {string} [opts.contextChannelId] - Channel ID from Assistant thread context ("this channel" when user opened from a channel)
 * @param {string} [opts.teamId] - Team ID for Enterprise Grid channel resolution
 * @returns {Promise<string>} Formatted context string for the prompt, or empty string
 */
async function buildSlackContext(client, opts = {}) {
  const {
    userToken,
    channelId,
    threadTs,
    userMessage = "",
    maxChannelMessages = 15,
    includeSearch = true,
    skipChannelAndThread = false,
    contextChannelId = null,
    teamId = null,
  } = opts;

  // Use user token (xoxp) for all Slack data reads when available; else bot (xoxb)
  const apiClient = userToken && userToken.trim()
    ? new WebClient(userToken)
    : client;

  const { ids: requestedIds, names: requestedNames } = parseChannelRefs(userMessage);
  if (DEBUG) {
    console.log("[slackContext] userToken:", !!userToken, "contextChannelId:", contextChannelId, "requestedIds:", requestedIds, "requestedNames:", requestedNames, "teamId:", teamId);
  }

  /** Fetch history for a channel by ID (e.g. context channel from "this channel"). */
  async function addChannelById(sectionsArray, cid, label) {
    if (!cid || cid === channelId) return; // skip if same as current (e.g. Assistant DM)
    try {
      const conv = await apiClient.conversations.info({ channel: cid });
      const name = conv.channel?.name ? `#${conv.channel.name}` : cid;
      const res = await apiClient.conversations.history({
        channel: cid,
        limit: Math.min(maxChannelMessages, 30),
      });
      const messages = (res.messages || [])
        .filter((m) => !m.subtype || m.subtype === "thread_broadcast")
        .slice(0, maxChannelMessages)
        .map((m) => {
          const user = m.user ? `<@${m.user}>` : "bot";
          const text = (m.text || "").trim();
          return text ? `${user}: ${text}` : null;
        })
        .filter(Boolean);
      if (messages.length > 0) {
        sectionsArray.push(`${label || `Recent messages in ${name}`}:\n${messages.join("\n")}`);
      }
    } catch (err) {
      const msg = err.data?.error ?? err.message;
      console.warn("[slackContext] addChannelById failed:", cid, msg);
      if (msg === "not_in_channel" || msg === "channel_not_found") {
        sectionsArray.push(`[Could not read the channel: the current token's user is not in that channel. Suggest the user open LivChat from the Apps menu to authorize—that will let me use their permissions to read channels they're in.]`);
      }
    }
  }

  /** Fetch history for channels mentioned in the message (IDs from <#C...|name>, names from #channel-name). */
  async function addRequestedChannels(sectionsArray) {
    for (const cid of requestedIds) {
      await addChannelById(sectionsArray, cid, null);
    }
    for (const name of requestedNames) {
      let cid = await resolveChannelByName(apiClient, name, teamId);
      if (cid) {
        try {
          const res = await apiClient.conversations.history({
            channel: cid,
            limit: Math.min(maxChannelMessages, 30),
          });
          const messages = (res.messages || [])
            .filter((m) => !m.subtype || m.subtype === "thread_broadcast")
            .slice(0, maxChannelMessages)
            .map((m) => {
              const user = m.user ? `<@${m.user}>` : "bot";
              const text = (m.text || "").trim();
              return text ? `${user}: ${text}` : null;
            })
            .filter(Boolean);
          if (messages.length > 0) {
            sectionsArray.push(`Recent messages in #${name}:\n${messages.join("\n")}`);
          }
        } catch (err) {
          if (DEBUG) console.error("[slackContext] conversations.history error:", err.message);
        }
        continue;
      }
      // Fallback: search in channel by name when we can't resolve (e.g. channel in other workspace)
      if (userToken && userToken.trim()) {
        try {
          const searchRes = await apiClient.search.messages({
            query: `in:${name}`,
            count: Math.min(maxChannelMessages, 20),
            sort: "timestamp",
            sort_dir: "desc",
          });
          const matches = searchRes.messages?.matches ?? [];
          if (matches.length > 0) {
            const lines = matches.map((m) => {
              const text = (m.text || "").trim();
              const ch = m.channel?.name ? `#${m.channel.name}` : "";
              return text ? (ch ? `[${ch}] ` : "") + text : null;
            }).filter(Boolean);
            if (lines.length > 0) {
              sectionsArray.push(`Messages from #${name} (via search):\n${lines.join("\n")}`);
            }
          }
        } catch (err) {
          if (DEBUG) console.error("[slackContext] search fallback error:", err.message);
        }
      }
    }
  }

  // Prefer Slack MCP server when we have a user token (required by Slack MCP)
  if (userToken && userToken.trim()) {
    const mcpContext = await buildContextViaMcp(userToken, {
      channelId: skipChannelAndThread ? undefined : channelId,
      threadTs: skipChannelAndThread ? undefined : threadTs,
      userMessage: includeSearch ? userMessage : "",
    });
    if (mcpContext) {
      const extra = [];
      await addChannelById(extra, contextChannelId, "Recent messages in this channel (from context):");
      await addRequestedChannels(extra);
      if (extra.length > 0) {
        return mcpContext.replace("--- End Slack context ---", `${extra.join("\n\n")}\n--- End Slack context ---`);
      }
      return mcpContext;
    }
    // Fall through to Web API if MCP fails (e.g. token scope, network)
  }

  const sections = [];

  try {
    // ----- Context channel ("this channel" when Assistant opened from a channel) -----
    await addChannelById(sections, contextChannelId, "Recent messages in this channel (from context):");
    // ----- Requested channels from message (e.g. "summarize #alerts-nws") -----
    await addRequestedChannels(sections);

    // ----- Channel / thread history (current conversation) -----
    if (channelId && !skipChannelAndThread) {
      let channelName = channelId;
      try {
        const conv = await apiClient.conversations.info({ channel: channelId });
        if (conv.channel?.name) channelName = `#${conv.channel.name}`;
      } catch (_) {}

      const historyOpts = {
        channel: channelId,
        limit: Math.min(maxChannelMessages, 20),
      };
      if (threadTs) {
        // Thread view: get replies in this thread
        const replies = await apiClient.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 25,
        });
        const messages = (replies.messages || []).map((m) => {
          const user = m.user ? `<@${m.user}>` : "bot";
          const text = (m.text || "").trim();
          return text ? `${user}: ${text}` : null;
        }).filter(Boolean);
        if (messages.length > 0) {
          sections.push(`Recent messages in this thread (${channelName}):\n${messages.join("\n")}`);
        }
      } else {
        const res = await apiClient.conversations.history(historyOpts);
        const messages = (res.messages || [])
          .filter((m) => !m.subtype || m.subtype === "thread_broadcast")
          .slice(0, maxChannelMessages)
          .map((m) => {
            const user = m.user ? `<@${m.user}>` : "bot";
            const text = (m.text || "").trim();
            return text ? `${user}: ${text}` : null;
          })
          .filter(Boolean);
        if (messages.length > 0) {
          sections.push(`Recent messages in ${channelName}:\n${messages.join("\n")}`);
        }
      }
    }

    // ----- Search (when user message looks like a question) -----
    const query = (userMessage || "").trim();
    if (includeSearch && query.length >= 3) {
      try {
        const searchRes = await apiClient.search.messages({ query, count: 5, sort: "score" });
        const matches = searchRes.messages?.matches ?? [];
        if (matches.length > 0) {
          const lines = matches.map((m) => {
            const text = (m.text || "").trim();
            const channel = m.channel?.name ? `#${m.channel.name}` : "";
            return channel ? `[${channel}] ${text}` : text;
          }).filter(Boolean);
          sections.push(`Slack search results for “${query.slice(0, 50)}…”:\n${lines.join("\n")}`);
        }
      } catch (_) {
        // search may not be available or rate limited
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.error("slackContext build error:", err.message);
    }
  }

  if (sections.length === 0) return "";
  return `\n--- Slack context (use this to answer with relevant workspace info) ---\n${sections.join("\n\n")}\n--- End Slack context ---\n`;
}

module.exports = { buildSlackContext };
