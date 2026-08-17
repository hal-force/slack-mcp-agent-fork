const { test } = require("node:test");
const assert = require("node:assert/strict");

const { canvasUpdate, canvasRead } = require("../src/canvas/userCanvasActions");

// A fake WebClient that records calls and never hits the network.
function fakeClient(edits = [], lookups = []) {
  return {
    canvases: {
      async edit(args) {
        edits.push(args);
        return { ok: true };
      },
      sections: {
        async lookup(args) {
          lookups.push(args);
          return { ok: true, sections: [] };
        },
      },
    },
  };
}

// ---- Regression: the "input must match regex pattern: ^[F][A-Z0-9]{8,}$" bug ----
// A loose id-extraction regex could pass a false-positive token (e.g. a
// fiscal-year code "FY2024Q1", or a short/lowercase id) into canvases.edit /
// sections.lookup, which Slack then rejected. The guard now short-circuits with
// a structured error BEFORE the SDK call.

test("canvasUpdate rejects a malformed canvas_id without calling the SDK", async () => {
  const edits = [];
  for (const badId of ["FY2024Q1", "F123", "fabcdefgh", "not-an-id", ""]) {
    const res = await canvasUpdate(fakeClient(edits), {
      canvas_id: badId,
      markdown: "hello",
      mode: "replace_all",
    });
    assert.equal(res.ok, false, `"${badId}" should be rejected`);
    assert.ok(
      res.error === "invalid_canvas_id" || res.error === "canvas_id_required",
      `"${badId}" → structured error, got ${res.error}`,
    );
  }
  assert.equal(edits.length, 0, "SDK edit must never be called with a bad id");
});

test("canvasUpdate accepts a valid F-id and calls the SDK", async () => {
  const edits = [];
  const res = await canvasUpdate(fakeClient(edits), {
    canvas_id: "F0ABCDE12",
    markdown: "# Report\nbody",
    mode: "replace_all",
  });
  assert.equal(res.ok, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].canvas_id, "F0ABCDE12");
  assert.equal(edits[0].changes[0].operation, "replace");
});

test("canvasRead rejects a malformed canvas_id without calling the SDK", async () => {
  const lookups = [];
  const res = await canvasRead(fakeClient([], lookups), { canvas_id: "FY2024Q1" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "invalid_canvas_id");
  assert.equal(lookups.length, 0);
});

test("canvasRead accepts a valid F-id and calls the SDK", async () => {
  const lookups = [];
  const res = await canvasRead(fakeClient([], lookups), { canvas_id: "F0ABCDE12" });
  assert.equal(res.ok, true);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].canvas_id, "F0ABCDE12");
});
