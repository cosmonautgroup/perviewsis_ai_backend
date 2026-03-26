/**
 * APM Sync Service
 * Pulls data from AppDynamics and Dynatrace APIs, stores it in PostgreSQL.
 * Runs on demand and optionally on a background schedule.
 * Every sync that produces new or updated records is logged to disk via SyncRunLogger.
 */

import { db } from "../db";
import {
  apmCredentials,
  dbApplications,
  dbIncidents,
  dbAlerts,
  dbServers,
  dbTransactions,
  dbErrors,
  dbMetrics,
  dbCapacityRisks,
  dbSyncLogs,
  ApmCredential,
} from "@shared/schema";
import { eq, and, count } from "drizzle-orm";
import { AppDynamicsClient, createAppDynamicsClient } from "./appDynamics";
import { DynatraceClient, createDynatraceClient, normalizeDTSeverity, normalizeDTStatus } from "./dynatrace";
import { SyncRunLogger } from "./syncRunLogger";
import { decryptSecret } from "./credentialCrypto";

export type SyncResult = {
  source: string;
  status: "success" | "failed" | "partial";
  recordsSynced: number;
  applicationsCount: number;
  incidentsCount: number;
  alertsCount: number;
  serversCount: number;
  errorMessage?: string;
  durationMs: number;
  syncRunId?: string;
};

const APPD_SYNC_WINDOW_MINS = 365 * 24 * 60;
const APPD_METRICS_WINDOW_MINS = 24 * 60;

// ─── AppDynamics Sync ────────────────────────────────────────────────────────
async function syncAppDynamics(credential?: ApmCredential): Promise<SyncResult> {
  const start = Date.now();
  const decryptedPassword = credential ? decryptSecret(credential.passwordHash) ?? "" : undefined;
  const client = credential
    ? new AppDynamicsClient({
        controllerUrl: credential.controllerUrl,
        account: credential.account ?? "",
        username: credential.username ?? "",
        password: decryptedPassword ?? process.env.APPDYNAMICS_PASSWORD ?? "",
      })
    : createAppDynamicsClient();

  if (!client) {
    return {
      source: "appdynamics",
      status: "failed",
      recordsSynced: 0,
      applicationsCount: 0,
      incidentsCount: 0,
      alertsCount: 0,
      serversCount: 0,
      errorMessage: "No AppDynamics credentials configured.",
      durationMs: Date.now() - start,
    };
  }

  const logger = new SyncRunLogger({
    orgId: credential?.organizationId ?? null,
    credentialId: credential?.id ?? null,
    integration: "appdynamics",
  });

  let applications = 0, incidents = 0, alerts = 0, servers = 0;
  const aggregateMetricSeries = (
    series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]
  ) => {
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
  };

  const saveAggregatedMetric = async (
    appId: number,
    metricName: string,
    series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]
  ) => {
    const points = aggregateMetricSeries(series);
    for (const p of points) {
      await db.insert(dbMetrics).values({
        entityId: String(appId),
        entityType: "application",
        source: "appdynamics",
        credentialId: credential?.id ?? null,
        metricName,
        recordedAt: new Date(p.ts),
        value: p.value,
      }).onConflictDoNothing();
    }
  };
  const saveMetricSeries = async (
    appId: number,
    metricName: string,
    series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]
  ) => {
    for (const s of series ?? []) {
      for (const point of s.metricValues ?? []) {
        if (point.value == null) continue;
        await db.insert(dbMetrics).values({
          entityId: String(appId),
          entityType: "application",
          source: "appdynamics",
          credentialId: credential?.id ?? null,
          metricName,
          recordedAt: new Date(point.startTimeInMillis),
          value: point.value,
        }).onConflictDoNothing();
      }
    }
  };

  try {
    // ── Bulk-fetch all existing externalIds for diff detection ──
    const [existingApps, existingIncidents, existingAlerts, existingServers, existingErrors] =
      await Promise.all([
        db.select({ externalId: dbApplications.externalId }).from(dbApplications).where(eq(dbApplications.source, "appdynamics")),
        db.select({ externalId: dbIncidents.externalId }).from(dbIncidents).where(eq(dbIncidents.source, "appdynamics")),
        db.select({ externalId: dbAlerts.externalId }).from(dbAlerts).where(eq(dbAlerts.source, "appdynamics")),
        db.select({ externalId: dbServers.externalId }).from(dbServers).where(eq(dbServers.source, "appdynamics")),
        db.select({ externalId: dbErrors.externalId }).from(dbErrors).where(eq(dbErrors.source, "appdynamics")),
      ]);

    const existingAppIds      = new Set(existingApps.map(r => r.externalId));
    const existingIncidentIds = new Set(existingIncidents.map(r => r.externalId));
    const existingAlertIds    = new Set(existingAlerts.map(r => r.externalId));
    const existingServerIds   = new Set(existingServers.map(r => r.externalId));
    const existingErrorIds    = new Set(existingErrors.map(r => r.externalId));

    // 1. Sync applications
    const apps = await client.getApplications();

    // Classify records before upserting
    const newApps     = apps.filter(a => !existingAppIds.has(String(a.id)));
    const updatedApps = apps.filter(a =>  existingAppIds.has(String(a.id)));
    logger.log({
      endpoint: "/controller/rest/applications",
      requestParams: { output: "JSON" },
      rawResponse: apps,
      newRecords: newApps,
      updatedRecords: updatedApps,
    });

    for (const app of apps) {
      await db
        .insert(dbApplications)
        .values({
          externalId: String(app.id),
          source: "appdynamics",
          credentialId: credential?.id ?? null,
          name: app.name,
          description: app.description,
          status: "Healthy",
          healthRuleViolations: 0,
          metadata: app as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbApplications.externalId, dbApplications.source, dbApplications.credentialId],
          set: {
            credentialId: credential?.id ?? null,
            name: app.name,
            description: app.description,
            metadata: app as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      applications++;

      // 1a. Sync tiers (metadata enrichment)
      try {
        const tiers = await client.getTiers(app.id);
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/tiers`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: tiers,
          newRecords: tiers,
          updatedRecords: [],
        });
        await db.update(dbApplications).set({
          metadata: { ...(app as any), tiers } as any,
          updatedAt: new Date(),
        }).where(and(
          eq(dbApplications.externalId, String(app.id)),
          eq(dbApplications.source, "appdynamics"),
          eq(dbApplications.credentialId, credential?.id ?? null),
        ));
      } catch (_) { }

      // 2. Sync problems/incidents per app
      try {
        const problems = await client.getProblems(app.id, APPD_SYNC_WINDOW_MINS);

        const newProblems     = problems.filter(p => !existingIncidentIds.has(String(p.id)));
        const updatedProblems = problems.filter(p =>  existingIncidentIds.has(String(p.id)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/problems`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: problems,
          newRecords: newProblems,
          updatedRecords: updatedProblems,
        });

        for (const problem of problems) {
          await db
            .insert(dbIncidents)
            .values({
              externalId: String(problem.id),
              source: "appdynamics",
              applicationId: String(app.id),
              title: problem.name,
              severity: problem.severity === "CRITICAL" ? "Critical" : "Warning",
              status: problem.status === "OPEN" ? "Open" : "Resolved",
              startTime: problem.startTime ? new Date(problem.startTime) : null,
              endTime: problem.endTime ? new Date(problem.endTime) : null,
              affectedServices: problem.affectedEntityDefinitions?.map((e: any) => e.name) ?? [],
              metadata: problem as any,
              lastSyncAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [dbIncidents.externalId, dbIncidents.source],
              set: {
                status: problem.status === "OPEN" ? "Open" : "Resolved",
                endTime: problem.endTime ? new Date(problem.endTime) : null,
                metadata: problem as any,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              },
            });
          incidents++;
        }
      } catch (_) { /* per-app errors are non-fatal */ }

      // 3. Sync health rule violations / alerts per app
      try {
        const violations = await client.getHealthRuleViolations(app.id, APPD_SYNC_WINDOW_MINS);
        let appViolationCount = 0;
        let hasCritical = false;
        let hasWarning = false;

        const newViolations     = violations.filter(v => !existingAlertIds.has(String(v.id)));
        const updatedViolations = violations.filter(v =>  existingAlertIds.has(String(v.id)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/healthrule-violations`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: violations,
          newRecords: newViolations,
          updatedRecords: updatedViolations,
        });

        for (const v of violations) {
          appViolationCount++;
          if (v.severity === "CRITICAL") hasCritical = true;
          else if (v.severity === "WARNING") hasWarning = true;

          await db
            .insert(dbAlerts)
            .values({
              externalId: String(v.id),
              source: "appdynamics",
              applicationId: String(app.id),
              name: v.healthRuleName,
              severity: v.severity === "CRITICAL" ? "Critical" : "Warning",
              status: v.incidentStatus === "OPEN" ? "Active" : "Resolved",
              triggeredAt: v.occurrenceTime ? new Date(v.occurrenceTime) : null,
              resolvedAt: v.resolvedTime ? new Date(v.resolvedTime) : null,
              metadata: v as any,
              lastSyncAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [dbAlerts.externalId, dbAlerts.source],
              set: {
                status: v.incidentStatus === "OPEN" ? "Active" : "Resolved",
                resolvedAt: v.resolvedTime ? new Date(v.resolvedTime) : null,
                metadata: v as any,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              },
            });
          alerts++;
        }

        if (violations.length > 0) {
          const status = hasCritical ? "Critical" : hasWarning ? "Warning" : "Healthy";
          await db
            .update(dbApplications)
            .set({ healthRuleViolations: appViolationCount, status, updatedAt: new Date() })
            .where(and(
              eq(dbApplications.externalId, String(app.id)),
              eq(dbApplications.source, "appdynamics"),
              eq(dbApplications.credentialId, credential?.id ?? null),
            ));
        }
      } catch (_) { }

      // 4. Sync nodes/servers per app
      try {
        const nodes = await client.getNodes(app.id);
        const tierCounts = new Map<string, number>();

        const newNodes     = nodes.filter(n => !existingServerIds.has(String(n.id)));
        const updatedNodes = nodes.filter(n =>  existingServerIds.has(String(n.id)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/nodes`,
          requestParams: { applicationId: app.id, output: "JSON" },
          rawResponse: nodes,
          newRecords: newNodes,
          updatedRecords: updatedNodes,
        });

        for (const node of nodes) {
          const ipList = node.ipAddresses?.ipAddresses ?? [];
          if (node.tierName) {
            tierCounts.set(node.tierName, (tierCounts.get(node.tierName) ?? 0) + 1);
          }
          await db
            .insert(dbServers)
            .values({
              externalId: String(node.id),
              source: "appdynamics",
              applicationId: String(app.id),
              name: node.name,
              ip: ipList[0] ?? null,
              tier: node.tierName,
              role: node.tierName,
              status: "Healthy",
              metadata: node as any,
              lastSyncAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [dbServers.externalId, dbServers.source],
              set: {
                name: node.name,
                tier: node.tierName,
                metadata: node as any,
                lastSyncAt: new Date(),
                updatedAt: new Date(),
              },
            });
          servers++;
        }

        if (tierCounts.size > 0) {
          const [topTier] = [...tierCounts.entries()].sort((a, b) => b[1] - a[1])[0];
          await db
            .update(dbApplications)
            .set({ tier: topTier, updatedAt: new Date() })
            .where(and(
              eq(dbApplications.externalId, String(app.id)),
              eq(dbApplications.source, "appdynamics"),
              eq(dbApplications.credentialId, credential?.id ?? null),
            ));
        }
      } catch (_) { }

      // 5. Sync business transactions
      try {
        const bts = await client.getBusinessTransactions(app.id);
        const latestPoint = (series: any[]): number | null => {
          let latestTs = -1;
          let latestVal: number | null = null;
          for (const s of series ?? []) {
            for (const p of s.metricValues ?? []) {
              if (p?.value == null) continue;
              const ts = Number(p.startTimeInMillis ?? 0);
              if (ts >= latestTs) {
                latestTs = ts;
                latestVal = Number(p.value);
              }
            }
          }
          return latestVal;
        };

        let totalCallsPerMin = 0;
        let totalErrorsPerMin = 0;
        let weightedRespSum = 0;
        for (const bt of bts) {
          const tier = bt.tierName ?? "";
          const btMetricBase = `Business Transaction Performance|Business Transactions|${tier}|${bt.name}`;
          const [btErrSeries, btCallsSeries, btRespSeries] = await Promise.all([
            client.getMetricData(app.id, `${btMetricBase}|Errors per Minute`, APPD_METRICS_WINDOW_MINS).catch(() => [] as any[]),
            client.getMetricData(app.id, `${btMetricBase}|Calls per Minute`, APPD_METRICS_WINDOW_MINS).catch(() => [] as any[]),
            client.getMetricData(app.id, `${btMetricBase}|Average Response Time (ms)`, APPD_METRICS_WINDOW_MINS).catch(() => [] as any[]),
          ]);

          const callsPerMinute = latestPoint(btCallsSeries) ?? bt.callsPerMinute ?? 0;
          const errorsPerMinute = latestPoint(btErrSeries) ?? bt.errorsPerMinute ?? 0;
          const averageResponseTime = latestPoint(btRespSeries) ?? bt.averageResponseTime ?? 0;
          const errorRate = callsPerMinute > 0 ? (errorsPerMinute / callsPerMinute) * 100 : 0;
          const btStatus = errorRate > 5 ? "Critical" : errorRate > 1 ? "Warning" : "Normal";

          totalCallsPerMin += callsPerMinute;
          totalErrorsPerMin += errorsPerMinute;
          weightedRespSum += averageResponseTime * callsPerMinute;
          await db.insert(dbTransactions).values({
            externalId: String(bt.id),
            source: "appdynamics",
            credentialId: credential?.id ?? null,
            applicationId: String(app.id),
            name: bt.name,
            tier: bt.tierName,
            avgResponseTime: averageResponseTime,
            callsPerMinute,
            errorRate,
            status: btStatus,
            metadata: {
              ...bt,
              metricsWindowMins: APPD_METRICS_WINDOW_MINS,
              metricCallsPerMinute: callsPerMinute,
              metricErrorsPerMinute: errorsPerMinute,
              metricAvgResponseTime: averageResponseTime,
            } as any,
            lastSyncAt: new Date(),
          }).onConflictDoUpdate({
            target: [dbTransactions.externalId, dbTransactions.source, dbTransactions.credentialId],
            set: {
              avgResponseTime: averageResponseTime,
              callsPerMinute,
              errorRate,
              status: btStatus,
              metadata: {
                ...bt,
                metricsWindowMins: APPD_METRICS_WINDOW_MINS,
                metricCallsPerMinute: callsPerMinute,
                metricErrorsPerMinute: errorsPerMinute,
                metricAvgResponseTime: averageResponseTime,
              } as any,
              lastSyncAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }

        if (bts.length > 0) {
          const avgResponseTime = totalCallsPerMin > 0 ? (weightedRespSum / totalCallsPerMin) : 0;
          const errorRate = totalCallsPerMin > 0 ? (totalErrorsPerMin / totalCallsPerMin) * 100 : 0;
          await db.update(dbApplications).set({
            callsPerMinute: totalCallsPerMin,
            avgResponseTime,
            errorRate,
            updatedAt: new Date(),
          }).where(and(
            eq(dbApplications.externalId, String(app.id)),
            eq(dbApplications.source, "appdynamics"),
            eq(dbApplications.credentialId, credential?.id ?? null),
          ));
        }
      } catch (_) { }

      // 6. Sync application error events
      try {
        const events = await client.getEvents(app.id, "APPLICATION_ERROR,DIAGNOSTIC_SESSION", APPD_SYNC_WINDOW_MINS);

        const newEvents     = events.filter(e => !existingErrorIds.has(String(e.id ?? `${app.id}-${e.eventTime ?? Date.now()}`)));
        const updatedEvents = events.filter(e =>  existingErrorIds.has(String(e.id ?? `${app.id}-${e.eventTime ?? Date.now()}`)));
        logger.log({
          endpoint: `/controller/rest/applications/${app.id}/events`,
          requestParams: { applicationId: app.id, eventTypes: "APPLICATION_ERROR,DIAGNOSTIC_SESSION", timerangeMinutes: APPD_SYNC_WINDOW_MINS },
          rawResponse: events,
          newRecords: newEvents,
          updatedRecords: updatedEvents,
        });

        for (const event of events) {
          const eventId = String(event.id ?? `${app.id}-${event.eventTime ?? Date.now()}`);
          const sevMap: Record<string, string> = { ERROR: "Critical", WARN: "High", INFO: "Low" };
          const severity = sevMap[event.severity] ?? "Medium";
          const errorMsg = event.summary ?? event.displayName ?? event.type ?? "Application Error";
          const errorType = event.type ?? "APPLICATION_ERROR";
          await db.insert(dbErrors).values({
            externalId: eventId,
            source: "appdynamics",
            applicationId: String(app.id),
            applicationName: app.name,
            cluster: `${app.name}-errors`,
            service: event.tierName ?? event.nodeName ?? app.name,
            message: errorMsg,
            errorType,
            frequency: 1,
            frequencyTrend: "stable",
            severity,
            status: "Active",
            firstSeen: event.eventTime ? new Date(event.eventTime) : new Date(),
            lastOccurrence: event.eventTime ? new Date(event.eventTime) : new Date(),
            metadata: event as any,
            lastSyncAt: new Date(),
          }).onConflictDoUpdate({
            target: [dbErrors.externalId, dbErrors.source],
            set: {
              service: event.tierName ?? event.nodeName ?? app.name,
              message: errorMsg,
              severity,
              lastOccurrence: event.eventTime ? new Date(event.eventTime) : new Date(),
              metadata: event as any,
              lastSyncAt: new Date(),
              updatedAt: new Date(),
            },
          });
        }
      } catch (_) { }

      // 7. Sync CPU metrics
      try {
        const cpuData = await client.getCpuMetrics(app.id, APPD_METRICS_WINDOW_MINS);
        await saveMetricSeries(app.id, "cpu_usage", cpuData);
      } catch (_) { }

      // 8. Sync response time + errors per minute + memory metrics
      try {
        const responseTime = await client.getResponseTimeMetrics(app.id, APPD_METRICS_WINDOW_MINS);
        await saveMetricSeries(app.id, "avg_response_time", responseTime);
      } catch (_) { }

      try {
        const errorsPerMin = await client.getErrorRateMetrics(app.id, APPD_METRICS_WINDOW_MINS);
        await saveMetricSeries(app.id, "errors_per_minute", errorsPerMin);
      } catch (_) { }

      try {
        const memory = await client.getMemoryMetrics(app.id, APPD_METRICS_WINDOW_MINS);
        await saveMetricSeries(app.id, "memory_usage", memory);
      } catch (_) { }

      // 9. Sync calls per minute
      try {
        const callsPerMin = await client.getMetricData(app.id, "Overall Application Performance|Calls per Minute", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "calls_per_minute", callsPerMin);
      } catch (_) { }

      // 10. Sync baseline response time (if available)
      try {
        const baseline = await client.getMetricData(app.id, "Overall Application Performance|Average Response Time (ms)|Baseline", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "baseline_avg_response_time", baseline);
      } catch (_) { }

      // 11. Sync JVM metrics
      try {
        const jvmHeapUsed = await client.getMetricData(app.id, "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Memory:Heap|Used (MB)", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "jvm_heap_used_mb", jvmHeapUsed);
      } catch (_) { }

      try {
        const jvmGcTime = await client.getMetricData(app.id, "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Garbage Collection|GC Time Spent Per Minute (ms)", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "jvm_gc_time_ms", jvmGcTime);
      } catch (_) { }

      // 12. Sync thread metrics
      try {
        const threads = await client.getMetricData(app.id, "Application Infrastructure Performance|*|Individual Nodes|*|JVM|Threads|Current No. of Threads", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "jvm_threads", threads);
      } catch (_) { }

      // 13. Sync business transaction response times
      try {
        const btResp = await client.getMetricData(app.id, "Business Transaction Performance|Business Transactions|*|Average Response Time (ms)", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "bt_avg_response_time", btResp);
      } catch (_) { }

      // 14. Sync database performance (backend response time)
      try {
        const dbResp = await client.getMetricData(app.id, "Backends|*|Average Response Time (ms)", APPD_METRICS_WINDOW_MINS);
        await saveAggregatedMetric(app.id, "db_avg_response_time", dbResp);
      } catch (_) { }
    }

    // Update credential last sync time
    if (credential) {
      await db.update(apmCredentials).set({ lastSyncAt: new Date() }).where(eq(apmCredentials.id, credential.id));
    }

    // Write the sync run log file
    const logResult = logger.flush();
    const syncRunId = logResult?.syncRunId;

    return {
      source: "appdynamics",
      status: "success",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      durationMs: Date.now() - start,
      syncRunId,
    };
  } catch (err: any) {
    logger.flush();
    return {
      source: "appdynamics",
      status: "failed",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      errorMessage: err.message,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Dynatrace Sync ──────────────────────────────────────────────────────────
async function syncDynatrace(credential?: ApmCredential): Promise<SyncResult> {
  const start = Date.now();
  const decryptedToken = credential ? decryptSecret(credential.apiToken) ?? "" : undefined;
  const client = credential
    ? new DynatraceClient({
        environmentUrl: credential.controllerUrl,
        apiToken: decryptedToken ?? process.env.DYNATRACE_TOKEN ?? "",
      })
    : createDynatraceClient();

  if (!client) {
    return {
      source: "dynatrace",
      status: "failed",
      recordsSynced: 0,
      applicationsCount: 0,
      incidentsCount: 0,
      alertsCount: 0,
      serversCount: 0,
      errorMessage: "No Dynatrace credentials configured.",
      durationMs: Date.now() - start,
    };
  }

  const logger = new SyncRunLogger({
    orgId: credential?.organizationId ?? null,
    credentialId: credential?.id ?? null,
    integration: "dynatrace",
  });

  let applications = 0, incidents = 0, alerts = 0, servers = 0;
  const aggregateMetricSeries = (
    series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]
  ) => {
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
  };

  const saveAggregatedMetric = async (
    appId: number,
    metricName: string,
    series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]
  ) => {
    const points = aggregateMetricSeries(series);
    for (const p of points) {
      await db.insert(dbMetrics).values({
        entityId: String(appId),
        entityType: "application",
        source: "appdynamics",
        credentialId: credential?.id ?? null,
        metricName,
        recordedAt: new Date(p.ts),
        value: p.value,
      }).onConflictDoNothing();
    }
  };
  const saveMetricSeries = async (
    appId: number,
    metricName: string,
    series: { metricValues?: { startTimeInMillis: number; value: number | null }[] }[]
  ) => {
    for (const s of series ?? []) {
      for (const point of s.metricValues ?? []) {
        if (point.value == null) continue;
        await db.insert(dbMetrics).values({
          entityId: String(appId),
          entityType: "application",
          source: "appdynamics",
          credentialId: credential?.id ?? null,
          metricName,
          recordedAt: new Date(point.startTimeInMillis),
          value: point.value,
        }).onConflictDoNothing();
      }
    }
  };

  try {
    // ── Bulk-fetch all existing externalIds ──
    const [existingApps, existingIncidents, existingServers] = await Promise.all([
      db.select({ externalId: dbApplications.externalId }).from(dbApplications).where(eq(dbApplications.source, "dynatrace")),
      db.select({ externalId: dbIncidents.externalId }).from(dbIncidents).where(eq(dbIncidents.source, "dynatrace")),
      db.select({ externalId: dbServers.externalId }).from(dbServers).where(eq(dbServers.source, "dynatrace")),
    ]);

    const existingAppIds      = new Set(existingApps.map(r => r.externalId));
    const existingIncidentIds = new Set(existingIncidents.map(r => r.externalId));
    const existingServerIds   = new Set(existingServers.map(r => r.externalId));

    // 1. Sync services as "applications"
    const { entities: services } = await client.getServices();

    const newServices     = services.filter(s => !existingAppIds.has(s.entityId));
    const updatedServices = services.filter(s =>  existingAppIds.has(s.entityId));
    logger.log({
      endpoint: "/api/v2/entities",
      requestParams: { entitySelector: "type(SERVICE)" },
      rawResponse: services,
      newRecords: newServices,
      updatedRecords: updatedServices,
    });

    for (const svc of services) {
      await db
        .insert(dbApplications)
        .values({
          externalId: svc.entityId,
          source: "dynatrace",
          credentialId: credential?.id ?? null,
          name: svc.displayName,
          status: "Healthy",
          healthRuleViolations: 0,
          metadata: svc as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbApplications.externalId, dbApplications.source, dbApplications.credentialId],
          set: {
            credentialId: credential?.id ?? null,
            name: svc.displayName,
            metadata: svc as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      applications++;
    }

    // 2. Sync problems as incidents
    const { problems } = await client.getProblems("now-24h");

    const newProblems     = problems.filter(p => !existingIncidentIds.has(p.problemId));
    const updatedProblems = problems.filter(p =>  existingIncidentIds.has(p.problemId));
    logger.log({
      endpoint: "/api/v2/problems",
      requestParams: { from: "now-24h" },
      rawResponse: problems,
      newRecords: newProblems,
      updatedRecords: updatedProblems,
    });

    for (const problem of problems) {
      const sev = normalizeDTSeverity(problem.severityLevel);
      const status = normalizeDTStatus(problem.status);
      await db
        .insert(dbIncidents)
        .values({
          externalId: problem.problemId,
          source: "dynatrace",
          applicationId: problem.impactedEntities?.[0]?.entityId?.id ?? null,
          title: problem.title,
          severity: sev,
          status,
          startTime: problem.startTime ? new Date(problem.startTime) : null,
          endTime: problem.endTime ? new Date(problem.endTime) : null,
          affectedServices: problem.impactedEntities?.map((e: any) => e.name) ?? [],
          metadata: problem as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbIncidents.externalId, dbIncidents.source],
          set: {
            status,
            endTime: problem.endTime ? new Date(problem.endTime) : null,
            metadata: problem as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      incidents++;
    }

    // 3. Sync hosts as servers
    const { entities: hosts } = await client.getHosts();

    const newHosts     = hosts.filter(h => !existingServerIds.has(h.entityId));
    const updatedHosts = hosts.filter(h =>  existingServerIds.has(h.entityId));
    logger.log({
      endpoint: "/api/v2/entities",
      requestParams: { entitySelector: "type(HOST)" },
      rawResponse: hosts,
      newRecords: newHosts,
      updatedRecords: updatedHosts,
    });

    for (const host of hosts) {
      await db
        .insert(dbServers)
        .values({
          externalId: host.entityId,
          source: "dynatrace",
          name: host.displayName,
          role: "Host",
          tier: "Infrastructure",
          status: "Healthy",
          metadata: host as any,
          lastSyncAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dbServers.externalId, dbServers.source],
          set: {
            name: host.displayName,
            metadata: host as any,
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          },
        });
      servers++;
    }

    // 4. Sync host CPU metrics
    try {
      const cpuResult = await client.getCpuMetrics("now-2h");
      for (const series of cpuResult.result ?? []) {
        for (const dataPoint of series.data ?? []) {
          for (let i = 0; i < dataPoint.timestamps.length; i++) {
            const val = dataPoint.values[i];
            if (val == null) continue;
            await db.insert(dbMetrics).values({
              entityId: series.metricId,
              entityType: "host",
              source: "dynatrace",
              credentialId: credential?.id ?? null,
              metricName: "cpu_usage",
              recordedAt: new Date(dataPoint.timestamps[i]),
              value: val,
            }).onConflictDoNothing();
          }
        }
      }
    } catch (_) { }

    // Update credential last sync time
    if (credential) {
      await db.update(apmCredentials).set({ lastSyncAt: new Date() }).where(eq(apmCredentials.id, credential.id));
    }

    const logResult = logger.flush();
    const syncRunId = logResult?.syncRunId;

    return {
      source: "dynatrace",
      status: "success",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      durationMs: Date.now() - start,
      syncRunId,
    };
  } catch (err: any) {
    logger.flush();
    return {
      source: "dynatrace",
      status: "failed",
      recordsSynced: applications + incidents + alerts + servers,
      applicationsCount: applications,
      incidentsCount: incidents,
      alertsCount: alerts,
      serversCount: servers,
      errorMessage: err.message,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────
export async function syncAll(): Promise<{ results: SyncResult[]; totalSynced: number }> {
  const results: SyncResult[] = [];

  let credentials: ApmCredential[] = [];
  try {
    credentials = await db.select().from(apmCredentials).where(eq(apmCredentials.isActive, true));
  } catch (_) { }

  const appdCredentials = credentials.filter(c => c.source === "appdynamics");
  const dtCredentials   = credentials.filter(c => c.source === "dynatrace");

  const hasAppdEnv = !!(process.env.APPDYNAMICS_URL && process.env.APPDYNAMICS_ACCOUNT && process.env.APPDYNAMICS_USERNAME && process.env.APPDYNAMICS_PASSWORD);
  if (appdCredentials.length === 0 && hasAppdEnv) {
    const logEntry = await db.insert(dbSyncLogs).values({ source: "appdynamics", startedAt: new Date(), status: "running" }).returning();
    const result = await syncAppDynamics();
    results.push(result);
    await db.update(dbSyncLogs).set({
      completedAt: new Date(),
      status: result.status,
      recordsSynced: result.recordsSynced,
      applicationsCount: result.applicationsCount,
      incidentsCount: result.incidentsCount,
      alertsCount: result.alertsCount,
      serversCount: result.serversCount,
      errorMessage: result.errorMessage ?? null,
    }).where(eq(dbSyncLogs.id, logEntry[0].id));
  } else if (appdCredentials.length > 0) {
    for (const cred of appdCredentials) {
      const logEntry = await db.insert(dbSyncLogs).values({ source: "appdynamics", credentialId: cred.id, startedAt: new Date(), status: "running" }).returning();
      const result = await syncAppDynamics(cred);
      results.push(result);
      await db.update(dbSyncLogs).set({
        completedAt: new Date(),
        status: result.status,
        recordsSynced: result.recordsSynced,
        applicationsCount: result.applicationsCount,
        incidentsCount: result.incidentsCount,
        alertsCount: result.alertsCount,
        serversCount: result.serversCount,
        errorMessage: result.errorMessage ?? null,
      }).where(eq(dbSyncLogs.id, logEntry[0].id));
    }
  }

  const hasDtEnv = !!(process.env.DYNATRACE_URL && process.env.DYNATRACE_TOKEN);
  if (dtCredentials.length === 0 && hasDtEnv) {
    const logEntry = await db.insert(dbSyncLogs).values({ source: "dynatrace", startedAt: new Date(), status: "running" }).returning();
    const result = await syncDynatrace();
    results.push(result);
    await db.update(dbSyncLogs).set({
      completedAt: new Date(),
      status: result.status,
      recordsSynced: result.recordsSynced,
      applicationsCount: result.applicationsCount,
      incidentsCount: result.incidentsCount,
      alertsCount: result.alertsCount,
      serversCount: result.serversCount,
      errorMessage: result.errorMessage ?? null,
    }).where(eq(dbSyncLogs.id, logEntry[0].id));
  } else if (dtCredentials.length > 0) {
    for (const cred of dtCredentials) {
      const logEntry = await db.insert(dbSyncLogs).values({ source: "dynatrace", credentialId: cred.id, startedAt: new Date(), status: "running" }).returning();
      const result = await syncDynatrace(cred);
      results.push(result);
      await db.update(dbSyncLogs).set({
        completedAt: new Date(),
        status: result.status,
        recordsSynced: result.recordsSynced,
        applicationsCount: result.applicationsCount,
        incidentsCount: result.incidentsCount,
        alertsCount: result.alertsCount,
        serversCount: result.serversCount,
        errorMessage: result.errorMessage ?? null,
      }).where(eq(dbSyncLogs.id, logEntry[0].id));
    }
  }

  const totalSynced = results.reduce((sum, r) => sum + r.recordsSynced, 0);
  return { results, totalSynced };
}

export async function syncSource(source: "appdynamics" | "dynatrace", credentialId?: number): Promise<SyncResult> {
  let credential: ApmCredential | undefined;
  if (credentialId) {
    const rows = await db.select().from(apmCredentials).where(and(eq(apmCredentials.id, credentialId), eq(apmCredentials.isActive, true)));
    credential = rows[0];
  } else {
    const rows = await db.select().from(apmCredentials).where(and(eq(apmCredentials.source, source), eq(apmCredentials.isActive, true))).limit(1);
    credential = rows[0];
  }
  return source === "appdynamics" ? syncAppDynamics(credential) : syncDynatrace(credential);
}

export async function getSyncStatus(): Promise<any> {
  try {
    const logs = await db.select().from(dbSyncLogs).orderBy(dbSyncLogs.startedAt).limit(20);
    const credentials = await db.select().from(apmCredentials);
    const [appCount]    = await db.select({ count: count() }).from(dbApplications);
    const [incCount]    = await db.select({ count: count() }).from(dbIncidents);
    const [alertCount]  = await db.select({ count: count() }).from(dbAlerts);
    const [serverCount] = await db.select({ count: count() }).from(dbServers);

    return {
      credentials: credentials.map(c => ({
        id: c.id,
        source: c.source,
        label: c.label,
        controllerUrl: c.controllerUrl,
        isActive: c.isActive,
        lastSyncAt: c.lastSyncAt,
      })),
      counts: {
        applications: appCount?.count ?? 0,
        incidents: incCount?.count ?? 0,
        alerts: alertCount?.count ?? 0,
        servers: serverCount?.count ?? 0,
      },
      recentLogs: logs.slice(-10).reverse(),
      envCredentials: {
        appDynamics: !!(process.env.APPDYNAMICS_URL && process.env.APPDYNAMICS_ACCOUNT),
        dynatrace: !!(process.env.DYNATRACE_URL && process.env.DYNATRACE_TOKEN),
      },
    };
  } catch {
    return { credentials: [], counts: {}, recentLogs: [], envCredentials: {} };
  }
}

export function startBackgroundSync(intervalMs = 60000) {
  console.log(`[SyncService] Background sync started — interval: ${intervalMs / 1000}s`);
  setInterval(async () => {
    console.log("[SyncService] Running scheduled sync…");
    try {
      const { results, totalSynced } = await syncAll();
      const summary = results.map(r => `${r.source}: ${r.status} (${r.recordsSynced} records${r.syncRunId ? `, run=${r.syncRunId.slice(0, 8)}` : ""})`).join(", ");
      console.log(`[SyncService] Sync complete — ${totalSynced} total records. ${summary}`);
    } catch (err: any) {
      console.error("[SyncService] Sync error:", err.message);
    }
  }, intervalMs);
}












