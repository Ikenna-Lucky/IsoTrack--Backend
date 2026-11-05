import { setTimeout as delay } from "node:timers/promises";

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

// Fixed arrivals: a slow server cannot silently reduce the offered workload.
// Drop rather than create an unbounded queue in the load generator.
export async function runPhase({ name, rate, seconds, maxInFlight }, execute) {
  const start = performance.now();
  const pending = new Set();
  const samples = {};
  const errors = [];
  let dropped = 0,
    peakInFlight = 0,
    maxSchedulingLagMs = 0;
  const offered = Math.floor(rate * seconds);
  for (let index = 0; index < offered; index++) {
    const due = start + (index * 1000) / rate;
    if (performance.now() < due) await delay(due - performance.now());
    const lag = Math.max(0, performance.now() - due);
    maxSchedulingLagMs = Math.max(maxSchedulingLagMs, lag);
    if (pending.size >= maxInFlight || lag > (1000 / rate) * 2) {
      dropped++;
      continue;
    }
    const began = performance.now();
    const task = Promise.resolve()
      .then(() => execute(index))
      .then((operation) => {
        (samples[operation] ??= []).push(performance.now() - began);
      })
      .catch((error) => {
        if (errors.length < 20) errors.push(String(error.message));
        (samples.failed ??= []).push(performance.now() - began);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
    peakInFlight = Math.max(peakInFlight, pending.size);
  }
  await Promise.all(pending);
  const remaining = start + seconds * 1000 - performance.now();
  if (remaining > 0) await delay(remaining);
  const elapsedSeconds = (performance.now() - start) / 1000;
  const operations = Object.fromEntries(
    Object.entries(samples).map(([key, values]) => [
      key,
      {
        count: values.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        p99Ms: percentile(values, 0.99),
        maxMs: Math.max(...values),
      },
    ]),
  );
  const completed = Object.values(operations).reduce(
    (sum, value) => sum + value.count,
    0,
  );
  return {
    name,
    rate,
    seconds,
    maxInFlight,
    offered,
    completed,
    dropped,
    failed: operations.failed?.count ?? 0,
    errors,
    operations,
    elapsedSeconds,
    completedPerSecond: completed / elapsedSeconds,
    peakInFlight,
    maxSchedulingLagMs,
  };
}

export function phaseFailures(result) {
  const failures = [];
  if (result.failed)
    failures.push(`${result.name}: ${result.failed} failed operations`);
  if (result.dropped)
    failures.push(`${result.name}: ${result.dropped} dropped arrivals`);
  const limits =
    result.name === "burst"
      ? { read: 1500, assign: 2500, deny: 1500 }
      : { read: 500, assign: 1000, deny: 500 };
  for (const [name, stats] of Object.entries(result.operations)) {
    const limit = name.startsWith("read-") ? limits.read : limits[name];
    if (limit && stats.p95Ms > limit)
      failures.push(
        `${result.name}/${name}: p95 ${stats.p95Ms.toFixed(1)}ms exceeds ${limit}ms`,
      );
  }
  if (result.completed + result.dropped !== result.offered)
    failures.push(`${result.name}: incomplete accounting`);
  return failures;
}
