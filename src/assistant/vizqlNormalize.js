/**
 * Normalize LLM-produced VizQL payloads toward Tableau MCP query-datasource / VDS shape.
 * @see https://tableau.github.io/tableau-mcp/docs/tools/data-qna/query-datasource
 */

/**
 * If the model pasted a full VDS-style body, unwrap to the inner `query` object.
 * @param {unknown} parsed
 * @returns {{ query: unknown, embeddedLuid?: string }}
 */
function coerceTableauMcpQueryInput(parsed) {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { query: parsed };
  }
  const ds = parsed.datasource;
  const q = parsed.query;
  if (ds && typeof ds === "object" && q != null && typeof q === "object" && !Array.isArray(q)) {
    const inner = { ...q };
    if (parsed.options && typeof parsed.options === "object") {
      const prev = inner.options && typeof inner.options === "object" ? inner.options : {};
      inner.options = { ...prev, ...parsed.options };
    }
    const embeddedLuid = ds.datasourceLuid != null ? String(ds.datasourceLuid).trim() : "";
    return { query: inner, embeddedLuid: embeddedLuid || undefined };
  }
  return { query: parsed };
}

function normalizeFieldReference(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const o = { ...obj };
  const cap =
    o.fieldCaption != null
      ? o.fieldCaption
      : o.fieldName != null
        ? o.fieldName
        : o.name != null
          ? o.name
          : o.column != null
            ? o.column
            : o.caption != null
              ? o.caption
              : null;
  if (cap != null) o.fieldCaption = String(cap);
  delete o.fieldName;
  delete o.name;
  delete o.column;
  delete o.caption;
  return o;
}

function normalizeFieldSpec(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return f;
  const o = normalizeFieldReference({ ...f });
  if (typeof o.function === "string") o.function = o.function.toUpperCase();
  return o;
}

function normalizeFilter(f) {
  if (!f || typeof f !== "object" || Array.isArray(f)) return f;
  const o = { ...f };
  if (o.field != null && typeof o.field === "object") o.field = normalizeFieldReference(o.field);
  else if (o.field != null && (typeof o.field === "string" || typeof o.field === "number")) {
    o.field = { fieldCaption: String(o.field) };
  }
  if (o.fieldToMeasure != null && typeof o.fieldToMeasure === "object") {
    o.fieldToMeasure = normalizeFieldReference(o.fieldToMeasure);
  }
  return o;
}

/**
 * @param {unknown} query
 * @returns {unknown}
 */
function normalizeVizqlQueryObject(query) {
  if (query == null || typeof query !== "object" || Array.isArray(query)) return query;
  const out = { ...query };
  if (Array.isArray(out.fields)) {
    out.fields = out.fields.map((f) => normalizeFieldSpec(f));
  }
  if (Array.isArray(out.filters)) {
    out.filters = out.filters.map((f) => normalizeFilter(f));
  }
  return out;
}

module.exports = {
  coerceTableauMcpQueryInput,
  normalizeVizqlQueryObject,
};
