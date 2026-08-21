const { WebClient } = require("@slack/web-api");
const { buildContextViaMcp } = require("./slackMcpClient");
const { channelAccessMissingScopeHintLines } = require("../slack/reinstallPrompt");

// user id → display name, cached across turns. users.info is called for every
// <@U…> mention in fetched context; the same handful of people recur constantly,
// so a short-TTL cache removes almost all of those calls (E6). Names change
// rarely, so a few minutes of staleness is fine. Bounded to avoid unbounded growth.
//
// The cache key MUST be tenant-scoped. Slack member IDs (U…) are unique only
// within a workspace / Enterprise-Grid org, NOT globally — this one process
// serves every installed workspace. Keying on the bare uid would let workspace
// Y render workspace X's cached display name for a colliding U-id (cross-tenant
// disclosure). Scope by token + teamId, same as the channel-id cache below.
const USER_NAME_TTL_MS = 10 * 60 * 1000;
const USER_NAME_CACHE_MAX = 2000;
/** @type {Map<string, { name: string, at: number }>} */
const _userNameCache = new Map();

function userNameCacheGet(key) {
  const hit = _userNameCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > USER_NAME_TTL_MS) {
    _userNameCache.delete(key);
    return undefined;
  }
  return hit.name;
}

function userNameCacheSet(key, name) {
  if (_userNameCache.size >= USER_NAME_CACHE_MAX) {
    const oldest = _userNameCache.keys().next().value;
    if (oldest !== undefined) _userNameCache.delete(oldest);
  }
  _userNameCache.set(key, { name, at: Date.now() });
}

/**
 * Resolve all <@UXXXXXX> mention tokens in a text string to display names.
 * Backed by a cross-turn TTL cache; only cache-missing ids hit users.info.
 * @param {import("@slack/web-api").WebClient} apiClient
 * @param {string} text
 * @returns {Promise<string>}
 */
async function resolveUserMentions(apiClient, text, teamId = null) {
  if (!text || typeof text !== "string") return text;
  const userIdRe = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/ ;
  if (!userIdRe.test(text)) return text;

  const ids = new Set();
  const allRe = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;
  let m;
  while ((m = allRe.exec(text)) !== null) ids.add(m[1]);

  // Tenant-scoped cache key: uid alone is not globally unique (see the cache
  // declaration above). Fold the token + teamId in so a U-id collision across
  // workspaces can never surface another tenant's name.
  const scope = `${tokenCacheKey(apiClient?.token)}:${teamId || "-"}`;
  const cacheKeyFor = (uid) => `${scope}:${uid}`;

  const nameById = {};
  const misses = [];
  for (const uid of ids) {
    const cached = userNameCacheGet(cacheKeyFor(uid));
    if (cached !== undefined) nameById[uid] = cached;
    else misses.push(uid);
  }

  await Promise.all(
    misses.map(async (uid) => {
      try {
        const res = await apiClient.users.info({ user: uid });
        const u = res.user;
        if (u) {
          const name =
            u.profile?.display_name_normalized ||
            u.profile?.display_name ||
            u.profile?.real_name_normalized ||
            u.real_name ||
            u.name ||
            uid;
          nameById[uid] = name;
          userNameCacheSet(cacheKeyFor(uid), name);
        }
      } catch (_) {
        // Leave unresolved mentions as-is if the API call fails.
      }
    })
  );

  return text.replace(/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g, (match, uid) =>
    nameById[uid] ? `@${nameById[uid]}` : match
  );
}

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
  // Plain #channel-name (exclude channel IDs - they look like #C0AL8UCPULW).
  // Require at least one letter so bare "#1", "#2024", "#3-priority" don't
  // trigger a (costly) channel-name resolution scan for non-channels (E5).
  // The leading (^|[^\w/]) boundary rejects URL fragments (…/docs#overview),
  // in-word "#", and markdown anchors so we don't scan/inject unrelated
  // channels for a pasted link (E5, correctness review).
  const plainRe = /(^|[^\w/])#([a-z0-9][a-z0-9._-]*)/gi;
  while ((m = plainRe.exec(text)) !== null) {
    const s = m[2];
    if (isChannelId(s)) continue;
    if (!/[a-z]/i.test(s)) continue; // purely numeric/symbolic → not a channel ref
    // Skip CSS/hex colors (#fff, #a1b2c3): all hex digits, length 3/4/6/8.
    if (/^[0-9a-f]+$/i.test(s) && [3, 4, 6, 8].includes(s.length)) continue;
    names.add(s.toLowerCase());
  }
  return { ids: [...ids], names: [...names] };
}

const DEBUG = process.env.SLACK_CONTEXT_DEBUG === "1";

/** Shown when history/replies succeed but there is nothing to list (so the model does not assume an access error). */
const NO_MESSAGES_IN_HISTORY =
  "No messages were found in the recent history we fetched—the channel may be empty, or recent activity had no text we could include.";

/**
 * @param {{ channelId?: string, channelLabel?: string, error: string }[]|null|undefined} errors
 */
function formatChannelAccessProblems(errors) {
  if (!errors || errors.length === 0) return "";
  const lines = errors.map((e) => {
    const ref = e.channelId ? `<#${e.channelId}>` : e.channelLabel || "channel";
    return `- ${ref}: \`${e.error}\``;
  });
  return [
    "Could not load message history for some channel(s):",
    ...lines,
    "",
    ...channelAccessMissingScopeHintLines(),
  ].join("\n");
}

/** Subtypes we include in channel history (user messages + thread_broadcast + app/bot posts). */
const INCLUDE_SUBTYPES = new Set(["thread_broadcast", "bot_message"]);

function includeMessageInHistory(m) {
  return !m.subtype || INCLUDE_SUBTYPES.has(m.subtype);
}

// Channel name → id resolution scans conversations.list, which paginates over
// the caller's entire channel membership. That's expensive and often repeated
// (same name across turns, several names in one message). Memoize results with a
// short TTL, keyed by the reading token + team + name so we never serve one
// user's private-channel resolution to another. Bounded so it can't grow without
// limit. (E5)
const CHANNEL_ID_TTL_MS = 5 * 60 * 1000;
const CHANNEL_ID_CACHE_MAX = 500;
/** @type {Map<string, { id: string|null, at: number }>} */
const _channelIdCache = new Map();

/** Stable, non-reversible cache key for a token (don't hold raw tokens in a Map key). */
function tokenCacheKey(token) {
  const t = String(token || "");
  if (!t) return "bot";
  // Cheap fold — collision-resistance isn't needed, just separation per token.
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `u${h}`;
}

function channelCacheGet(key) {
  const hit = _channelIdCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CHANNEL_ID_TTL_MS) {
    _channelIdCache.delete(key);
    return undefined;
  }
  return hit.id;
}

function channelCacheSet(key, id) {
  if (_channelIdCache.size >= CHANNEL_ID_CACHE_MAX) {
    // Evict the oldest inserted entry (Map preserves insertion order).
    const oldest = _channelIdCache.keys().next().value;
    if (oldest !== undefined) _channelIdCache.delete(oldest);
  }
  _channelIdCache.set(key, { id, at: Date.now() });
}

/** Resolve a channel name to channel ID via conversations.list (uses provided client: user or bot). */
async function resolveChannelByName(client, name, teamId) {
  if (!client) return null;
  const cacheKey = `${tokenCacheKey(client?.token)}:${teamId || "-"}:${String(name).toLowerCase()}`;
  const cached = channelCacheGet(cacheKey);
  if (cached !== undefined) return cached;

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
  channelCacheSet(cacheKey, cid);
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
 * @param {{ channelId?: string, channelLabel?: string, error: string }[]} [opts.channelAccessErrors] - when provided, failed channel reads are recorded here for callers / prompt text
 * @returns {Promise<string>} Formatted context string for the prompt, or empty string
 */
async function buildSlackContext(client, opts = {}) {
  const {
    userToken,
    channelId,
    threadTs,
    userMessage = "",
    maxChannelMessages = Number(process.env.SLACK_MAX_CHANNEL_MESSAGES) || 8,
    includeSearch = true,
    skipChannelAndThread = false,
    contextChannelId = null,
    teamId = null,
    channelAccessErrors = null,
  } = opts;

  const hasUserToken = !!(userToken && userToken.trim());
  // User-delegated client (xoxp): only set when we actually hold a user token.
  // Reads that could reach content the *requesting* user can't see — channels
  // they merely named, and workspace-wide search — MUST use this, never the bot
  // token. The bot may belong to channels the user doesn't; falling back to it
  // would let "summarize #private-channel" leak content across the auth boundary
  // (S6). userApiClient is null when there's no user token, and those reads are
  // then refused (recorded as an access problem that prompts authorization).
  const userApiClient = hasUserToken ? new WebClient(userToken) : null;
  // For reads of the *current* conversation (the channel/thread the request came
  // from, or the "this channel" the Assistant was opened from) the user is
  // demonstrably present, so the bot token is an acceptable fallback.
  const apiClient = userApiClient || client;

  const { ids: requestedIds, names: requestedNames } = parseChannelRefs(userMessage);
  if (DEBUG) {
    console.log("[slackContext] userToken:", !!userToken, "contextChannelId:", contextChannelId, "requestedIds:", requestedIds, "requestedNames:", requestedNames, "teamId:", teamId);
  }

  /**
   * Fetch history for a channel by ID.
   * @param {WebClient} readClient - which token reads this channel (user vs bot)
   */
  async function addChannelById(sectionsArray, cid, label, readClient = apiClient) {
    if (!cid || cid === channelId) return; // skip if same as current (e.g. Assistant DM)
    try {
      const conv = await readClient.conversations.info({ channel: cid });
      const name = conv.channel?.name ? `#${conv.channel.name}` : cid;
      const res = await readClient.conversations.history({
        channel: cid,
        limit: Math.min(maxChannelMessages, 30),
      });
      const messages = (res.messages || [])
        .filter(includeMessageInHistory)
        .slice(0, maxChannelMessages)
        .map((m) => {
          const user = m.user ? `<@${m.user}>` : (m.bot_id ? "bot" : "app");
          const text = (m.text || "").trim();
          return text ? `${user}: ${text}` : null;
        })
        .filter(Boolean);
      if (messages.length > 0) {
        sectionsArray.push(`${label || `Recent messages in ${name}`}:\n${messages.join("\n")}`);
      } else {
        sectionsArray.push(`${label || `Recent messages in ${name}`}:\n${NO_MESSAGES_IN_HISTORY}`);
        if (DEBUG) {
          console.log("[slackContext] addChannelById:", cid, "returned 0 messages (empty or all filtered)");
        }
      }
    } catch (err) {
      const msg = err.data?.error ?? err.message;
      console.warn("[slackContext] addChannelById failed:", cid, msg);
      if (Array.isArray(channelAccessErrors)) {
        channelAccessErrors.push({ channelId: cid, error: String(msg) });
      }
    }
  }

  /** Fetch history for channels mentioned in the message (IDs from <#C...|name>, names from #channel-name). */
  async function addRequestedChannels(sectionsArray) {
    // Channels the user merely *named* (not the conversation they're in) must be
    // read with their own token — the bot may see channels they can't (S6).
    if ((requestedIds.length || requestedNames.length) && !userApiClient) {
      if (Array.isArray(channelAccessErrors)) {
        for (const cid of requestedIds) {
          channelAccessErrors.push({ channelId: cid, error: "not_authorized_without_user_token" });
        }
        for (const name of requestedNames) {
          channelAccessErrors.push({ channelLabel: `#${name}`, error: "not_authorized_without_user_token" });
        }
      }
      if (DEBUG) console.log("[slackContext] refusing named-channel read without user token");
      return;
    }
    for (const cid of requestedIds) {
      await addChannelById(sectionsArray, cid, null, userApiClient);
    }
    for (const name of requestedNames) {
      let cid = await resolveChannelByName(userApiClient, name, teamId);
      if (cid) {
        try {
          const res = await userApiClient.conversations.history({
            channel: cid,
            limit: Math.min(maxChannelMessages, 30),
          });
          const messages = (res.messages || [])
            .filter(includeMessageInHistory)
            .slice(0, maxChannelMessages)
            .map((m) => {
              const user = m.user ? `<@${m.user}>` : (m.bot_id ? "bot" : "app");
              const text = (m.text || "").trim();
              return text ? `${user}: ${text}` : null;
            })
            .filter(Boolean);
          if (messages.length > 0) {
            sectionsArray.push(`Recent messages in #${name}:\n${messages.join("\n")}`);
          } else {
            sectionsArray.push(`Recent messages in #${name}:\n${NO_MESSAGES_IN_HISTORY}`);
          }
        } catch (err) {
          const apiErr = err.data?.error ?? err.message;
          if (DEBUG) console.error("[slackContext] conversations.history error:", err.message);
          if (Array.isArray(channelAccessErrors)) {
            channelAccessErrors.push({
              channelLabel: `#${name}`,
              channelId: cid,
              error: String(apiErr),
            });
          }
        }
        continue;
      }
      // Fallback: search in channel by name when we can't resolve (e.g. channel in other workspace)
      if (userApiClient) {
        try {
          const searchRes = await userApiClient.search.messages({
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
      const problems = formatChannelAccessProblems(
        Array.isArray(channelAccessErrors) ? channelAccessErrors : null,
      );
      const tail = [extra.length > 0 ? extra.join("\n\n") : "", problems].filter(Boolean).join("\n\n");
      const mcpResult = tail
        ? mcpContext.replace("--- End Slack context ---", `${tail}\n--- End Slack context ---`)
        : mcpContext;
      try {
        return await resolveUserMentions(apiClient, mcpResult, teamId);
      } catch (_) {
        return mcpResult;
      }
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
        } else {
          sections.push(
            `Recent messages in this thread (${channelName}):\nNo replies were found in this thread yet, or none had text we could include.`
          );
        }
      } else {
        const res = await apiClient.conversations.history(historyOpts);
        const messages = (res.messages || [])
          .filter(includeMessageInHistory)
          .slice(0, maxChannelMessages)
          .map((m) => {
            const user = m.user ? `<@${m.user}>` : (m.bot_id ? "bot" : "app");
            const text = (m.text || "").trim();
            return text ? `${user}: ${text}` : null;
          })
          .filter(Boolean);
        if (messages.length > 0) {
          sections.push(`Recent messages in ${channelName}:\n${messages.join("\n")}`);
        } else {
          sections.push(`Recent messages in ${channelName}:\n${NO_MESSAGES_IN_HISTORY}`);
        }
      }
    }

    // ----- Search (when user message looks like a question) -----
    // Workspace search must use the user's token so results are scoped to what
    // they can see (search:read is a user scope; a bot-token call would fail
    // anyway). Skip entirely without a user token (S6).
    const query = (userMessage || "").trim();
    if (includeSearch && query.length >= 3 && userApiClient) {
      try {
        const searchRes = await userApiClient.search.messages({ query, count: 20, sort: "score" });
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
    // Log unconditionally (message only, no secrets) so a live-demo context
    // failure is diagnosable rather than silent (correctness review #6).
    console.warn("[slackContext] context build failed:", err.message);
  }

  const accessProblems =
    Array.isArray(channelAccessErrors) && channelAccessErrors.length > 0
      ? formatChannelAccessProblems(channelAccessErrors)
      : "";

  if (sections.length === 0 && !accessProblems) return "";
  const header =
    "\n--- Slack context (internal workspace—prioritize this over general knowledge when answering) ---\n";
  const body = [sections.join("\n\n"), accessProblems].filter(Boolean).join("\n\n");
  const raw = `${header}${body}\n--- End Slack context ---\n`;
  try {
    return await resolveUserMentions(apiClient, raw, teamId);
  } catch (_) {
    return raw;
  }
}

module.exports = {
  buildSlackContext,
  parseChannelRefs,
  // exported for tests
  resolveUserMentions,
};
