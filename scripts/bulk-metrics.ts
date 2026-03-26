import { db } from "../server/db";
import { apmCredentials, dbMetrics } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "../server/services/credentialCrypto";
import { AppDynamicsClient } from "../server/services/appDynamics";

type MetricSpec = {
  name: string;
  path: string;
  aggregate: boolean;
};

const METRICS: MetricSpec[] = [
  { name: "calls_per_minute", path: "Overall Application Performance|Calls per Minute", aggregate: true },
  { name: "avg_response_time", path: "Overall Application Performance|Average Response Time (ms)", aggregate: true },
  { name: "errors_per_minute", path: "Overall Application Performance|Errors per Minute", aggregate: true },
  { name: "slow_calls", path: "Overall Application Performance|Slow Calls", aggregate: true },
  { name: "cpu_usage", path: "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|CPU|%Busy", aggregate: true },
  { name: "memory_usage", path: "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Memory|Used %", aggregate: true },
  { name: "disk_usage", path: "Application Infrastructure Performance|*|Individual Nodes|*|Hardware Resources|Disk|Used %", aggregate: true },
  { name: "jvm_heap_used_pct", path: "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Memory|Heap|Used %", aggregate: true },
  { name: "jvm_gc_time_ms", path: "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Garbage Collection|GC Time Spent (ms)", aggregate: true },
  { name: "jvm_threads", path: "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Threads|Thread Count", aggregate: true },
  { name: "bt_errors_per_minute", path: "Business Transaction Performance|*|Errors per Minute", aggregate: true },
  { name: "bt_avg_response_time", path: "Business Transaction Performance|*|Average Response Time (ms)", aggregate: true },
  { name: "bt_calls_per_minute", path: "Business Transaction Performance|*|Calls per Minute", aggregate: true },
];

const durationMins = Number(process.env.BULK_METRICS_MINS ?? 10080);

function aggregateSeries(series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]) {
  const bucket = new Map<number, { sum: number; count: number }>();
  for (const s of series ?? []) {
    for (const point of s.metricValues ?? []) {
      if (point.value == null) continue;
      const entry = bucket.get(point.startTimeInMillis) ?? { sum: 0, count: 0 };
      entry.sum += point.value;
      entry.count += 1;
      bucket.set(point.startTimeInMillis, entry);
    }
  }
  return [...bucket.entries()].map(([ts, agg]) => ({
    ts,
    value: agg.count > 0 ? agg.sum / agg.count : 0,
  }));
}

async function saveAggregatedMetric(appId: number, metricName: string, series: any[]) {
  const points = aggregateSeries(series);
  const seen = new Set<string>();
  for (const p of points) {
    const key = `${metricName}:${p.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await db.insert(dbMetrics).values({
      entityId: String(appId),
      entityType: "application",
      source: "appdynamics",
      metricName,
      recordedAt: new Date(p.ts),
      value: p.value,
    }).onConflictDoNothing();
  }
}

async function run() {
  const creds = await db
    .select()
    .from(apmCredentials)
    .where(and(eq(apmCredentials.source, "appdynamics"), eq(apmCredentials.isActive, true)));

  if (creds.length === 0) {
    console.log("No active AppDynamics credentials found.");
    return;
  }

  for (const cred of creds) {
    const client = new AppDynamicsClient({
      controllerUrl: cred.controllerUrl,
      account: cred.account ?? "",
      username: cred.username ?? "",
      password: decryptSecret(cred.passwordHash) ?? "",
    });

    let apps: { id: number; name: string }[] = [];
    try {
      apps = await client.getApplications();
    } catch (err: any) {
      console.error(`[BulkMetrics] Failed to list apps for cred ${cred.id}:`, err.message);
      continue;
    }

    for (const app of apps) {
      for (const metric of METRICS) {
        try {
          const series = await client.getMetricData(app.id, metric.path, durationMins);
          if (!series || series.length === 0) continue;
          await saveAggregatedMetric(app.id, metric.name, series);
        } catch (err: any) {
          console.error(`[BulkMetrics] ${cred.id} app ${app.id} metric ${metric.name} failed:`, err.message);
        }
      }
    }
  }
}

run().then(() => {
  console.log("Bulk metrics import complete.");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
