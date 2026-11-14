// Node 24 puts final JUnit counts in XML comments. Reject missing or truncated counts.
export function requirePassingReport(xml) {
  if (
    !xml.includes("<testsuites>") ||
    !xml.trimEnd().endsWith("</testsuites>") ||
    !/<testcase\b/.test(xml) ||
    /<(failure|error|skipped)\b/.test(xml)
  ) {
    throw new Error("Missing, truncated or unsuccessful JUnit report");
  }
  const counts = {};
  for (const name of [
    "tests",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
  ]) {
    const matches = [
      ...xml.matchAll(new RegExp(`<!-- ${name} (\\d+) -->`, "g")),
    ];
    if (matches.length !== 1)
      throw new Error(`Missing or ambiguous ${name} count`);
    counts[name] = Number(matches[0][1]);
    if (!Number.isSafeInteger(counts[name]))
      throw new Error(`Invalid ${name} count`);
  }
  if (
    counts.tests < 1 ||
    counts.pass !== counts.tests ||
    counts.fail ||
    counts.cancelled ||
    counts.skipped ||
    counts.todo
  ) {
    throw new Error(
      "All discovered tests must execute and pass without skips or todos",
    );
  }
  return counts;
}
