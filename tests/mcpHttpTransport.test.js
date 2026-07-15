const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseMcpResponse,
  parseSseForId,
  splitSseEvents,
  dataPayloadFromEvent,
  isRetriableStatus,
} = require("../src/assistant/mcpHttpTransport");

test("parses a single-line SSE data payload", () => {
  const sse = 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  const msg = parseMcpResponse(sse, 1);
  assert.equal(msg?.result?.ok, true);
});

test("REGRESSION: joins multi-line data fields in one event (large payload truncation bug)", () => {
  // A single SSE event whose JSON is split across several `data:` lines.
  // The old parser JSON.parsed each line and returned null → dropped result.
  const sse = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":42,',
    'data: "result":{"content":[{"type":"text","text":"BIG PAYLOAD"}]}}',
    "",
  ].join("\n");
  const msg = parseMcpResponse(sse, 42);
  assert.ok(msg, "message should parse");
  assert.equal(msg.result.content[0].text, "BIG PAYLOAD");
});

test("selects the matching id among multiple SSE events", () => {
  const sse = [
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
    "",
    'data: {"jsonrpc":"2.0","id":7,"result":{"x":1}}',
    "",
  ].join("\n");
  assert.equal(parseMcpResponse(sse, 7)?.result?.x, 1);
});

test("handles a final event with no trailing blank line", () => {
  const sse = [
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
    "",
    'data: {"jsonrpc":"2.0","id":9,"result":{"done":true}}',
  ].join("\n");
  assert.equal(parseMcpResponse(sse, 9)?.result?.done, true);
});

test("coerces string vs numeric JSON-RPC ids", () => {
  assert.ok(parseMcpResponse('data: {"id":"7","result":{}}\n\n', 7));
  assert.ok(parseMcpResponse('{"id":7,"result":{}}', "7"));
});

test("last message with a duplicate id wins (interim then final)", () => {
  const sse = [
    'data: {"id":9,"result":{"stage":"interim"}}',
    "",
    'data: {"id":9,"result":{"stage":"final"}}',
    "",
  ].join("\n");
  assert.equal(parseSseForId(sse, 9).result.stage, "final");
});

test("handles CRLF line endings", () => {
  const sse = 'event: message\r\ndata: {"id":3,"result":{"ok":true}}\r\n\r\n';
  assert.equal(parseMcpResponse(sse, 3)?.result?.ok, true);
});

test("parses whole-body application/json responses", () => {
  assert.equal(parseMcpResponse('{"id":5,"result":{"v":2}}', 5)?.result?.v, 2);
});

test("returns null when no id matches", () => {
  assert.equal(parseMcpResponse('data: {"id":1,"result":{}}\n\n', 999), null);
});

test("ignores [DONE] sentinel and malformed data lines", () => {
  const sse = [
    "data: [DONE]",
    "",
    "data: not-json",
    "",
    'data: {"id":2,"result":{"ok":1}}',
    "",
  ].join("\n");
  assert.equal(parseMcpResponse(sse, 2)?.result?.ok, 1);
});

test("splitSseEvents / dataPayloadFromEvent helpers", () => {
  const events = splitSseEvents("data: a\n\ndata: b\n\n");
  assert.equal(events.length, 2);
  assert.equal(dataPayloadFromEvent("data: x\ndata: y"), "x\ny");
  assert.equal(dataPayloadFromEvent("event: ping"), null);
});

test("isRetriableStatus: 5xx and 429 retriable; 4xx and 2xx not", () => {
  assert.equal(isRetriableStatus(500), true);
  assert.equal(isRetriableStatus(503), true);
  assert.equal(isRetriableStatus(429), true);
  assert.equal(isRetriableStatus(400), false);
  assert.equal(isRetriableStatus(401), false);
  assert.equal(isRetriableStatus(200), false);
});
