/**
 * Tableau skill — pre-fetches Tableau context (datasource list, metadata, optional view image)
 * before the LLM call, replacing the prior function-declaration dispatch pattern.
 */

const { buildTableauContext } = require("../assistant/tableauContextBuilder");
const {
  callTableauTool,
  resolveTableauMcpUrl,
  extractImageBuffersFromMcpToolResult,
  extensionForMime,
} = require("../assistant/tableauMcpClient");

const VISUAL_SIGNAL =
  /\b(dashboard|screenshot|snapshot|chart|graph|trend|revenue|kpi|quarter|visual|view\s+image|show\s+me|display)\b/i;

const SYSTEM_PROMPT_SECTION = `Tableau Data:
- Ground numbers in Tableau tool output only. Never invent field captions, LUIDs, or figures.
- When a PNG view image is included below the reply, tell the user the snapshot is there and describe what it shows.
- For exact figures, use exact field names from metadata. For breakdowns, prefer bullets over tables (Slack does not render pipe tables).
- If context includes *Closest published data sources*, map the user's wording to the best LUID or ask them to confirm before citing numbers.
- If data is missing or empty, say so—do not invent figures.`;

function wantsViewImage(userMessage, intents) {
  return VISUAL_SIGNAL.test(userMessage || "");
}

function normalizeKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreViewForMessage(view, msg) {
  const n = normalizeKey(view.name || "");
  const m = normalizeKey(msg);
  if (!n || !m) return 0;
  if (m.includes(n) || n.includes(m)) return n.length + 10;
  let score = 0;
  for (const word of n.split(" ")) {
    if (word.length >= 3 && m.includes(word)) score += word.length;
  }
  return score;
}

function pickBestView(views, userMessage) {
  if (!views.length) return null;
  if (views.length === 1) return views[0];
  const ranked = views
    .map((v) => ({ v, s: scoreViewForMessage(v, userMessage) }))
    .sort((a, b) => b.s - a.s);
  const top = ranked[0];
  return top.s > 0 ? top.v : views[0];
}

function parseViewEntries(text) {
  let t = String(text || "").trim();
  try {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : j?.views || j?.data?.views || [];
    if (Array.isArray(arr)) {
      return arr
        .filter((v) => v && (v.id || v.viewId || v.luid))
        .map((v) => ({ id: String(v.id || v.viewId || v.luid), name: String(v.name || v.viewName || "View") }));
    }
  } catch (_) {
    const start = t.search(/[{[]/);
    if (start > 0) {
      try {
        const j2 = JSON.parse(t.slice(start));
        const arr = Array.isArray(j2) ? j2 : j2?.views || j2?.data?.views || [];
        if (Array.isArray(arr)) {
          return arr
            .filter((v) => v && (v.id || v.viewId || v.luid))
            .map((v) => ({ id: String(v.id || v.viewId || v.luid), name: String(v.name || v.viewName || "View") }));
        }
      } catch (_2) {}
    }
  }
  return [];
}

async function tryFetchViewImage(tableauMcpBaseUrl, userMessage) {
  try {
    const mcpOpts = { tableauMcpBaseUrl };
    const { text: listText } = await callTableauTool("list-views", { limit: 100 }, mcpOpts);
    const views = parseViewEntries(listText || "");
    const best = pickBestView(views, userMessage);
    if (!best) return [];

    const { result } = await callTableauTool(
      "get-view-image",
      { viewId: best.id, width: 1400, height: 900, format: "PNG" },
      mcpOpts,
    );
    const images = extractImageBuffersFromMcpToolResult(result);
    return images.map((im, idx) => {
      const ext = extensionForMime(im.mimeType);
      const suffix = images.length > 1 ? `-${idx + 1}` : "";
      return {
        buffer: im.buffer,
        filename: `tableau-view-${best.id.slice(0, 8)}${suffix}.${ext}`,
        title: `Tableau: ${best.name}`,
      };
    });
  } catch (_) {
    return [];
  }
}

function createTableauSkill() {
  return {
    name: "tableau",
    matchesIntent: (intents) => Array.isArray(intents) && intents.includes("tableau"),
    isAvailable: (caps) => !!caps.tableauEnabled,
    systemPromptSection: SYSTEM_PROMPT_SECTION,

    async execute({ userMessage, threadHistory, intents, sessionOpts }) {
      const { tableauMcpBaseUrl, threadHint } = sessionOpts;
      if (!resolveTableauMcpUrl(tableauMcpBaseUrl)) {
        return { contextText: "", uploads: [], sideEffects: [] };
      }

      const resolvedThreadHint = threadHint || (Array.isArray(threadHistory)
        ? threadHistory.map((m) => m.text || "").join("\n")
        : "");
      const wantTableau = Array.isArray(intents) && intents.includes("tableau");

      const [{ context: contextText }, viewUploads] = await Promise.all([
        buildTableauContext(userMessage, { tableauMcpBaseUrl, wantTableau, threadHint: resolvedThreadHint }),
        wantsViewImage(userMessage, intents)
          ? tryFetchViewImage(tableauMcpBaseUrl, userMessage)
          : Promise.resolve([]),
      ]);

      return { contextText: contextText || "", uploads: viewUploads, sideEffects: [] };
    },
  };
}

module.exports = { createTableauSkill };
