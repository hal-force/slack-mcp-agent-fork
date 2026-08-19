const { test } = require("node:test");
const assert = require("node:assert");
const brief = require("../src/jobs/vhaDailyBrief");

const facilities = brief.loadDims().facilities;

test("parseBindings tolerates unset and bad JSON", () => {
  const prev = process.env.VHA_BRIEF_BINDINGS;
  delete process.env.VHA_BRIEF_BINDINGS;
  assert.deepEqual(brief.parseBindings(), []);
  process.env.VHA_BRIEF_BINDINGS = "not json{";
  assert.deepEqual(brief.parseBindings(), []);
  process.env.VHA_BRIEF_BINDINGS = '[{"slackId":"U1","facilityName":"Phoenix, AZ HCS","role":"director"}]';
  assert.equal(brief.parseBindings().length, 1);
  if (prev === undefined) delete process.env.VHA_BRIEF_BINDINGS; else process.env.VHA_BRIEF_BINDINGS = prev;
});

test("applyDirectorBinding rebinds only the named facility, without mutating input", () => {
  const out = brief.applyDirectorBinding(facilities, { slackId: "U_JGILL", facilityName: "Phoenix, AZ HCS" });
  const phx = out.find((f) => f.facility_name === "Phoenix, AZ HCS");
  const tuc = out.find((f) => f.facility_name === "Tucson, AZ HCS");
  assert.equal(phx.director_user, "U_JGILL");
  assert.notEqual(tuc.director_user, "U_JGILL"); // untouched
  // original not mutated
  const origPhx = facilities.find((f) => f.facility_name === "Phoenix, AZ HCS");
  assert.notEqual(origPhx.director_user, "U_JGILL");
});

test("director binding → selectBriefRows resolves facility-wide (ALL, all 5 flagged)", () => {
  const dims = brief.loadDims();
  dims.facilities = brief.applyDirectorBinding(dims.facilities, { slackId: "U_JGILL", facilityName: "Phoenix, AZ HCS" });
  const sel = brief.selectBriefRows({ id: "U_JGILL", tz: "America/Phoenix", locale: "en-US" }, dims, { kind: "scan" });
  assert.equal(sel.facility.facility_name, "Phoenix, AZ HCS");
  assert.equal(sel.functions, "ALL");
  assert.equal(sel.rows.length, 5);
});

test("role binding → user is pinned to that facility + owning_function only", () => {
  const dims = brief.loadDims();
  const user = brief.applyRoleBindingToUser(
    { id: "U_JGILL", tz: "America/Phoenix", locale: "en-US" },
    { facilityName: "Phoenix, AZ HCS", role: "Quality Manager" },
    dims.facilities,
  );
  const sel = brief.selectBriefRows(user, dims, { kind: "scan" });
  assert.equal(sel.facility.facility_name, "Phoenix, AZ HCS");
  assert.deepEqual(sel.functions, ["Quality Manager"]);
  // Quality Manager owns SMR30 + OMELOS only
  assert.deepEqual(sel.rows.map((r) => r.metric_key).sort(), ["OMELOS", "SMR30"]);
});

test("targetUserIds prefers bound ids over roster/director default", () => {
  const prev = process.env.VHA_BRIEF_USERS;
  delete process.env.VHA_BRIEF_USERS;
  assert.deepEqual(brief.targetUserIds([], facilities, ["U_JGILL"]), ["U_JGILL"]);
  if (prev === undefined) delete process.env.VHA_BRIEF_USERS; else process.env.VHA_BRIEF_USERS = prev;
});
