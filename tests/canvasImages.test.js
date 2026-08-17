const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractUploadedFiles,
  buildCanvasImageSection,
  embedImagesInCanvases,
} = require("../src/canvas/canvasImages");

// ---- files.uploadV2 response normalization ----
// The SDK nests uploaded files differently across versions; extract must find
// {id, permalink} regardless of nesting depth so canvas embedding works.

test("extractUploadedFiles handles the nested { files:[{ files:[...] }] } shape", () => {
  const res = {
    files: [
      { files: [{ id: "F111", permalink: "https://files.slack.com/a.png", title: "Chart A" }] },
    ],
  };
  const refs = extractUploadedFiles(res);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, "F111");
  assert.equal(refs[0].permalink, "https://files.slack.com/a.png");
  assert.equal(refs[0].title, "Chart A");
});

test("extractUploadedFiles handles the flat { files:[{id,permalink}] } shape", () => {
  const res = { files: [{ id: "F222", permalink: "https://files.slack.com/b.png" }] };
  const refs = extractUploadedFiles(res);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, "F222");
});

test("extractUploadedFiles dedupes and skips files without a permalink", () => {
  const res = {
    files: [
      { files: [{ id: "F1", permalink: "https://x/1.png" }] },
      { files: [{ id: "F1", permalink: "https://x/1.png" }] }, // dup
      { files: [{ id: "F2" }] }, // no permalink → skipped
    ],
  };
  const refs = extractUploadedFiles(res);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, "F1");
});

// ---- canvas markdown image section (file unfurls) ----

test("buildCanvasImageSection emits a bare permalink per image (unfurl) with caption", () => {
  const md = buildCanvasImageSection([
    { permalink: "https://files.slack.com/chart.png", title: "Funding Trend" },
  ]);
  assert.match(md, /## Visualizations/);
  assert.match(md, /\*\*Funding Trend\*\*/);
  assert.match(md, /^https:\/\/files\.slack\.com\/chart\.png$/m, "permalink must sit alone on a line to unfurl");
});

test("buildCanvasImageSection returns empty string when there are no images", () => {
  assert.equal(buildCanvasImageSection([]), "");
  assert.equal(buildCanvasImageSection(null), "");
  assert.equal(buildCanvasImageSection([{ title: "no link" }]), "");
});

// ---- orchestration: append image section to each written canvas ----

test("embedImagesInCanvases appends an append_end update per canvas via injected dispatch", async () => {
  const calls = [];
  const fakeDispatch = async (userToken, name, args, ctx) => {
    calls.push({ userToken, name, args, ctx });
    return { ok: true };
  };
  const n = await embedImagesInCanvases(
    {
      userToken: "xoxp-test",
      canvasUpdates: [{ canvas_id: "F0ABCDE12" }, { canvas_id: "F0FGHIJ34" }],
      imageRefs: [{ permalink: "https://files.slack.com/v.png", title: "View" }],
      teamId: "T1",
      defaultChannelId: "C1",
    },
    fakeDispatch,
  );
  assert.equal(n, 2, "both canvases updated");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "slack_canvas_update");
  assert.equal(calls[0].args.mode, "append_end");
  assert.match(calls[0].args.markdown, /files\.slack\.com\/v\.png/);
  assert.equal(calls[0].args.canvas_id, "F0ABCDE12");
});

test("embedImagesInCanvases is a no-op without a user token, canvases, or images", async () => {
  let called = 0;
  const d = async () => { called++; return { ok: true }; };
  assert.equal(await embedImagesInCanvases({ userToken: "", canvasUpdates: [{ canvas_id: "F0A" }], imageRefs: [{ permalink: "x" }] }, d), 0);
  assert.equal(await embedImagesInCanvases({ userToken: "x", canvasUpdates: [], imageRefs: [{ permalink: "x" }] }, d), 0);
  assert.equal(await embedImagesInCanvases({ userToken: "x", canvasUpdates: [{ canvas_id: "F0A" }], imageRefs: [] }, d), 0);
  assert.equal(called, 0, "dispatch never called on no-op paths");
});

test("embedImagesInCanvases counts only successful canvas writes", async () => {
  const d = async (_t, _n, args) => (args.canvas_id === "F0BAD00" ? { ok: false, error: "x" } : { ok: true });
  const n = await embedImagesInCanvases(
    {
      userToken: "xoxp",
      canvasUpdates: [{ canvas_id: "F0GOOD11" }, { canvas_id: "F0BAD00" }],
      imageRefs: [{ permalink: "https://x/y.png" }],
    },
    d,
  );
  assert.equal(n, 1, "only the successful write is counted");
});
