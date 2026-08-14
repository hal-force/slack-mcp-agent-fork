const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveTableauMcpUrl,
  getDefaultTableauMcpUrl,
} = require("../src/assistant/tableauMcpClient");

const SNAPSHOT = process.env.TABLEAU_MCP_SERVER;
afterEach(() => {
  if (SNAPSHOT === undefined) delete process.env.TABLEAU_MCP_SERVER;
  else process.env.TABLEAU_MCP_SERVER = SNAPSHOT;
});

// The gating value (caps.tableauEnabled = !!tableauMcpBaseUrl) is computed from
// resolveTableauMcpUrl(override). getTableauMcpUrlOverride() returns undefined when
// the user has no personal override, so the fallback to TABLEAU_MCP_SERVER here is
// what lets a deployment-wide default enable the Tableau skill. Regression guard:
// if this fallback is dropped, the bot reports "no Tableau MCP tool available"
// even though TABLEAU_MCP_SERVER is set.

test("no override + no host default → empty (Tableau disabled)", () => {
  delete process.env.TABLEAU_MCP_SERVER;
  assert.equal(resolveTableauMcpUrl(undefined), "");
  assert.equal(!!resolveTableauMcpUrl(undefined), false);
});

test("no override + host default set → resolves to host default (Tableau enabled)", () => {
  process.env.TABLEAU_MCP_SERVER = "https://federal-tableau-mcp.example.com/tableau-mcp";
  assert.equal(
    resolveTableauMcpUrl(undefined),
    "https://federal-tableau-mcp.example.com/tableau-mcp",
  );
  assert.equal(!!resolveTableauMcpUrl(undefined), true);
});

test("per-user override wins over host default", () => {
  process.env.TABLEAU_MCP_SERVER = "https://host-default.example.com/tableau-mcp";
  assert.equal(
    resolveTableauMcpUrl("https://my-override.example.com/mcp"),
    "https://my-override.example.com/mcp",
  );
});

test("trailing slash is normalized off (override and default)", () => {
  process.env.TABLEAU_MCP_SERVER = "https://host.example.com/tableau-mcp/";
  assert.equal(getDefaultTableauMcpUrl(), "https://host.example.com/tableau-mcp");
  assert.equal(resolveTableauMcpUrl("https://o.example.com/mcp/"), "https://o.example.com/mcp");
});
