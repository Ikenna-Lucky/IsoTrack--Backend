import assert from "node:assert/strict";
import { test } from "node:test";
import { requirePassingReport } from "../scripts/test-report.mjs";

const report = (overrides = {}) =>
  `<testsuites><testcase name="example"/>${Object.entries({
    tests: 1,
    pass: 1,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    ...overrides,
  })
    .map(([key, value]) => `<!-- ${key} ${value} -->`)
    .join("")}</testsuites>`;

test("complete passing reports return execution counts", () => {
  assert.equal(requirePassingReport(report()).tests, 1);
});
test("zero tests, skipped tests, todos, failures and cancellations cannot pass", () => {
  for (const counts of [
    { tests: 0, pass: 0 },
    { skipped: 1 },
    { todo: 1 },
    { fail: 1 },
    { cancelled: 1 },
  ]) {
    assert.throws(() => requirePassingReport(report(counts)));
  }
});
test("missing, truncated and ambiguous reports cannot pass", () => {
  for (const xml of [
    "",
    report().replace("</testsuites>", ""),
    report().replace("<!-- tests 1 -->", ""),
    report().replace("</testsuites>", "<!-- tests 1 --></testsuites>"),
  ]) {
    assert.throws(() => requirePassingReport(xml));
  }
});
test("failure elements cannot hide behind successful summary counts", () => {
  assert.throws(() =>
    requirePassingReport(report().replace("<testcase", "<failure/><testcase")),
  );
});
